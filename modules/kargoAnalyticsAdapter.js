import { logError, logWarn } from '../src/utils.js';
import { ajax } from '../src/ajax.js';
import adapter from '../libraries/analyticsAdapter/AnalyticsAdapter.js';
import adapterManager from '../src/adapterManager.js';
import { EVENTS } from '../src/constants.js';
import { getGlobal } from '../src/prebidGlobal.js';

/// /////////// CONSTANTS //////////////
const ADAPTER_CODE = 'kargo';
const KARGO_BIDDER_CODE = 'kargo';
const ANALYTICS_VERSION = '2.0';
const ENDPOINT_BASE = 'https://krk.kargo.com/api/v2/analytics';
const SEND_DELAY = 500; // ms delay to allow BID_WON events
const LOG_PREFIX = 'Kargo Analytics: ';
const CURRENCY_USD = 'USD';

/// /////////// DEFAULT CONFIG //////////////
const DEFAULT_CONFIG = {
  sampling: 100, // Percentage of auctions to track (1-100)
  sendWinEvents: true, // Send individual win events
  sendDelay: SEND_DELAY, // Delay before sending auction data (ms)
};

/// /////////// STATE //////////////
const cache = {
  auctions: {}, // Map<auctionId, AuctionData>
};

let _config = { ...DEFAULT_CONFIG };
let _sampled = true; // Whether this session is sampled

/// /////////// HELPER FUNCTIONS //////////////

/**
 * Determines if current session should be sampled based on config
 */
function shouldSample() {
  const samplingRate = _config.sampling || 100;
  return Math.random() * 100 < samplingRate;
}

/**
 * Converts CPM to USD using Prebid's currency conversion if available
 */
function convertToUsd(cpm, currency) {
  if (!cpm || cpm <= 0) return null;

  if (!currency || currency.toUpperCase() === CURRENCY_USD) {
    return parseFloat(Number(cpm).toFixed(3));
  }

  try {
    const convertCurrency = getGlobal().convertCurrency;
    if (typeof convertCurrency === 'function') {
      return parseFloat(Number(convertCurrency(cpm, currency, CURRENCY_USD)).toFixed(3));
    }
  } catch (e) {
    logWarn(LOG_PREFIX + 'Currency conversion failed:', e);
  }

  // Return original CPM if conversion not available
  return parseFloat(Number(cpm).toFixed(3));
}

/**
 * Extracts sizes from mediaTypes object
 */
function extractSizes(mediaTypes) {
  if (!mediaTypes) return [];

  const sizes = [];
  if (mediaTypes.banner?.sizes) {
    sizes.push(...mediaTypes.banner.sizes);
  }
  if (mediaTypes.video) {
    const { playerSize } = mediaTypes.video;
    if (playerSize) {
      sizes.push(Array.isArray(playerSize[0]) ? playerSize[0] : playerSize);
    }
  }
  return sizes;
}

/**
 * Extracts privacy consent data from bidder request
 */
function extractConsent(bidderRequest) {
  if (!bidderRequest) return null;

  const consent = {};

  // GDPR
  if (bidderRequest.gdprConsent) {
    consent.gdpr = {
      applies: !!bidderRequest.gdprConsent.gdprApplies,
      consentString: bidderRequest.gdprConsent.consentString ? '[present]' : null,
    };
  }

  // USP (CCPA)
  if (bidderRequest.uspConsent) {
    consent.usp = bidderRequest.uspConsent;
  }

  // GPP
  if (bidderRequest.gppConsent) {
    consent.gpp = {
      gppString: bidderRequest.gppConsent.gppString ? '[present]' : null,
      applicableSections: bidderRequest.gppConsent.applicableSections,
    };
  }

  // COPPA
  if (bidderRequest.coppa) {
    consent.coppa = true;
  }

  return Object.keys(consent).length > 0 ? consent : null;
}

/**
 * Calculates rank of a bid within an ad unit
 */
function calculateRank(adUnit, cpm) {
  if (!cpm || !adUnit?.bids) return null;

  const cpms = Object.values(adUnit.bids)
    .filter(b => b.status === 'received' && b.cpmUsd > 0)
    .map(b => b.cpmUsd)
    .sort((a, b) => b - a);

  const index = cpms.indexOf(cpm);
  return index >= 0 ? index + 1 : null;
}

/**
 * Counts total bids requested across all ad units
 */
function countTotalBids(auctionCache) {
  return Object.values(auctionCache.adUnits || {})
    .reduce((total, adUnit) => total + Object.keys(adUnit.bids || {}).length, 0);
}

/**
 * Calculates average of an array of numbers
 */
function average(arr) {
  const filtered = arr.filter(n => n != null && !isNaN(n));
  if (filtered.length === 0) return null;
  return parseFloat((filtered.reduce((a, b) => a + b, 0) / filtered.length).toFixed(2));
}

/// /////////// EVENT HANDLERS //////////////

/**
 * Handles AUCTION_INIT event - initializes auction cache
 */
function handleAuctionInit(args) {
  const { auctionId, timeout, adUnits, bidderRequests } = args;

  if (!auctionId) {
    logWarn(LOG_PREFIX + 'AUCTION_INIT missing auctionId');
    return;
  }

  cache.auctions[auctionId] = {
    timestamp: Date.now(),
    timeout,
    adUnits: {},
    bidderRequests: bidderRequests?.map(br => br.bidderCode) || [],
    bidsReceived: [],
    noBids: [],
    timeouts: [],
    errors: [],
    winningBids: {},
    consent: extractConsent(bidderRequests?.[0]),
    referer: bidderRequests?.[0]?.refererInfo?.topmostLocation || bidderRequests?.[0]?.refererInfo?.page,
    sent: false,
  };

  // Initialize ad units
  if (adUnits) {
    adUnits.forEach(adUnit => {
      cache.auctions[auctionId].adUnits[adUnit.code] = {
        code: adUnit.code,
        mediaTypes: Object.keys(adUnit.mediaTypes || {}),
        sizes: adUnit.sizes || extractSizes(adUnit.mediaTypes),
        bids: {},
        status: 'pending',
      };
    });
  }
}

/**
 * Handles BID_REQUESTED event - tracks bid requests per ad unit
 */
function handleBidRequested(args) {
  const { auctionId, bidderCode, bids } = args;
  const auctionCache = cache.auctions[auctionId];

  if (!auctionCache) return;

  if (bids) {
    bids.forEach(bid => {
      const adUnit = auctionCache.adUnits[bid.adUnitCode];
      if (adUnit) {
        adUnit.bids[bid.bidId] = {
          bidder: bidderCode,
          bidId: bid.bidId,
          status: 'pending',
          requestTimestamp: Date.now(),
          isKargo: bidderCode === KARGO_BIDDER_CODE,
        };
      }
    });
  }
}

/**
 * Handles BID_RESPONSE event - records bid details
 */
function handleBidResponse(args) {
  const {
    auctionId, adUnitCode, bidder, bidderCode, requestId, originalRequestId,
    cpm, currency, timeToRespond, mediaType, width, height, dealId, meta
  } = args;

  const auctionCache = cache.auctions[auctionId];
  if (!auctionCache) return;

  const adUnit = auctionCache.adUnits[adUnitCode];
  if (!adUnit) return;

  const bidId = originalRequestId || requestId;
  const bidData = adUnit.bids[bidId] || {};
  const actualBidder = bidderCode || bidder;

  const cpmUsd = convertToUsd(cpm, currency);

  adUnit.bids[bidId] = {
    ...bidData,
    bidder: actualBidder,
    bidId: requestId,
    status: 'received',
    cpm,
    currency,
    cpmUsd,
    responseTime: timeToRespond,
    mediaType,
    size: width && height ? `${width}x${height}` : null,
    dealId: dealId || null,
    advertiserDomains: meta?.advertiserDomains?.slice(0, 5) || null,
    isKargo: actualBidder === KARGO_BIDDER_CODE,
  };

  auctionCache.bidsReceived.push({
    adUnitCode,
    bidder: actualBidder,
    cpm,
    cpmUsd,
  });
}

/**
 * Handles NO_BID event - tracks no-bid responses
 */
function handleNoBid(args) {
  const { auctionId, adUnitCode, bidder, bidId } = args;

  const auctionCache = cache.auctions[auctionId];
  if (!auctionCache) return;

  const adUnit = auctionCache.adUnits[adUnitCode];
  if (adUnit && adUnit.bids[bidId]) {
    adUnit.bids[bidId].status = 'no-bid';
  }

  auctionCache.noBids.push({ adUnitCode, bidder });
}

/**
 * Handles BID_TIMEOUT event - tracks timed out bids
 */
function handleBidTimeout(args) {
  // args is an array of timed-out bids
  if (!Array.isArray(args)) return;

  args.forEach(bid => {
    const { auctionId, adUnitCode, bidder, bidId } = bid;

    const auctionCache = cache.auctions[auctionId];
    if (!auctionCache) return;

    const adUnit = auctionCache.adUnits[adUnitCode];
    if (adUnit && adUnit.bids[bidId]) {
      adUnit.bids[bidId].status = 'timeout';
    }

    auctionCache.timeouts.push({ adUnitCode, bidder });
  });
}

/**
 * Handles BIDDER_DONE event - finalizes bidder response tracking
 */
function handleBidderDone(args) {
  const { auctionId, bids } = args;

  const auctionCache = cache.auctions[auctionId];
  if (!auctionCache) return;

  // Mark any bids still pending as no-bid
  if (bids) {
    bids.forEach(bid => {
      const adUnit = auctionCache.adUnits[bid.adUnitCode];
      if (adUnit) {
        const cachedBid = adUnit.bids[bid.bidId];
        if (cachedBid && cachedBid.status === 'pending') {
          cachedBid.status = 'no-bid';
        }
        // Capture server response time if available
        if (typeof bid.serverResponseTimeMs !== 'undefined') {
          cachedBid.serverResponseTime = bid.serverResponseTimeMs;
        }
      }
    });
  }
}

/**
 * Handles BIDDER_ERROR event - captures error details
 */
function handleBidderError(args) {
  const { auctionId, bidderCode, error, bidderRequest } = args;

  // Try to get auctionId from bidderRequest if not directly available
  const effectiveAuctionId = auctionId || bidderRequest?.auctionId;
  const auctionCache = cache.auctions[effectiveAuctionId];
  if (!auctionCache) return;

  auctionCache.errors.push({
    bidder: bidderCode,
    error: {
      message: error?.message || 'Unknown error',
      status: error?.status,
    },
    timestamp: Date.now(),
  });

  // Mark any bids from this bidder as error
  Object.values(auctionCache.adUnits).forEach(adUnit => {
    Object.values(adUnit.bids).forEach(bid => {
      if (bid.bidder === bidderCode && bid.status === 'pending') {
        bid.status = 'error';
      }
    });
  });
}

/**
 * Handles AUCTION_END event - calculates summary and sends data
 */
function handleAuctionEnd(args) {
  const { auctionId } = args;

  const auctionCache = cache.auctions[auctionId];
  if (!auctionCache || auctionCache.sent) return;

  // Calculate auction summary
  auctionCache.endTimestamp = Date.now();
  auctionCache.duration = auctionCache.endTimestamp - auctionCache.timestamp;

  // Find highest CPM bids per ad unit
  try {
    const highestBids = getGlobal().getHighestCpmBids() || [];
    highestBids.forEach(bid => {
      if (bid.auctionId === auctionId) {
        auctionCache.winningBids[bid.adUnitCode] = {
          bidder: bid.bidderCode,
          cpm: bid.cpm,
          cpmUsd: convertToUsd(bid.cpm, bid.currency),
          bidId: bid.requestId,
        };
      }
    });
  } catch (e) {
    logError(LOG_PREFIX + 'Error getting highest CPM bids:', e);
  }

  // Send after short delay to allow BID_WON events
  setTimeout(() => {
    sendAuctionAnalytics(auctionId);
  }, _config.sendDelay || SEND_DELAY);
}

/**
 * Handles BID_WON event - marks winning bids
 */
function handleBidWon(args) {
  const { auctionId, adUnitCode, bidderCode, cpm, currency, requestId } = args;

  const auctionCache = cache.auctions[auctionId];
  if (!auctionCache) return;

  // Update the winning bid in cache
  auctionCache.winningBids[adUnitCode] = {
    bidder: bidderCode,
    cpm,
    cpmUsd: convertToUsd(cpm, currency),
    bidId: requestId,
    won: true,
  };

  // Mark the bid as won in ad unit
  const adUnit = auctionCache.adUnits[adUnitCode];
  if (adUnit) {
    Object.values(adUnit.bids).forEach(bid => {
      if (bid.bidId === requestId || bid.bidder === bidderCode) {
        bid.won = true;
      }
    });
  }

  // Send individual win event if configured
  if (_config.sendWinEvents && !auctionCache.sent) {
    sendWinAnalytics(auctionId, adUnitCode);
  }
}

/// /////////// EVENT HANDLER MAP //////////////

const eventHandlers = {
  [EVENTS.AUCTION_INIT]: handleAuctionInit,
  [EVENTS.BID_REQUESTED]: handleBidRequested,
  [EVENTS.BID_RESPONSE]: handleBidResponse,
  [EVENTS.NO_BID]: handleNoBid,
  [EVENTS.BID_TIMEOUT]: handleBidTimeout,
  [EVENTS.BIDDER_DONE]: handleBidderDone,
  [EVENTS.BIDDER_ERROR]: handleBidderError,
  [EVENTS.AUCTION_END]: handleAuctionEnd,
  [EVENTS.BID_WON]: handleBidWon,
};

/// /////////// DATA FORMATTERS //////////////

/**
 * Extracts Kargo-specific metrics from auction cache
 */
function extractKargoMetrics(auctionCache) {
  const kargoBids = [];

  Object.entries(auctionCache.adUnits || {}).forEach(([code, adUnit]) => {
    Object.values(adUnit.bids || {}).forEach(bid => {
      if (bid.isKargo) {
        const winningBid = auctionCache.winningBids[code];
        kargoBids.push({
          adUnitCode: code,
          status: bid.status,
          cpm: bid.cpmUsd,
          responseTime: bid.responseTime,
          won: bid.won || false,
          // Competitive metrics
          winningBidder: winningBid?.bidder || null,
          winningCpm: winningBid?.cpmUsd || null,
          marginToWin: winningBid?.cpmUsd && bid.cpmUsd
            ? parseFloat((winningBid.cpmUsd - bid.cpmUsd).toFixed(3))
            : null,
          rank: calculateRank(adUnit, bid.cpmUsd),
        });
      }
    });
  });

  return {
    bidCount: kargoBids.length,
    bids: kargoBids,
    winCount: kargoBids.filter(b => b.won).length,
    avgResponseTime: average(kargoBids.map(b => b.responseTime)),
    avgCpm: average(kargoBids.filter(b => b.cpm).map(b => b.cpm)),
  };
}

/**
 * Formats the auction payload for sending
 */
function formatAuctionPayload(auctionId, auctionCache) {
  return {
    // Metadata
    version: ANALYTICS_VERSION,
    timestamp: Date.now(),
    prebidVersion: '$prebid.version$',

    // Auction identifiers
    auctionId,

    // Timing
    auctionTimeout: auctionCache.timeout,
    auctionDuration: auctionCache.duration,

    // Page context
    pageUrl: auctionCache.referer,

    // Consent
    consent: auctionCache.consent,

    // Kargo-specific performance
    kargo: extractKargoMetrics(auctionCache),

    // Competitive intelligence (anonymized)
    auction: {
      bidderCount: auctionCache.bidderRequests?.length || 0,
      totalBidsRequested: countTotalBids(auctionCache),
      totalBidsReceived: auctionCache.bidsReceived?.length || 0,
      totalNoBids: auctionCache.noBids?.length || 0,
      totalTimeouts: auctionCache.timeouts?.length || 0,
      totalErrors: auctionCache.errors?.length || 0,
    },

    // Per-ad-unit summary
    adUnits: Object.entries(auctionCache.adUnits || {}).map(([code, adUnit]) => ({
      code,
      mediaTypes: adUnit.mediaTypes,
      bidders: Object.values(adUnit.bids || {}).map(bid => ({
        bidder: bid.bidder,
        status: bid.status,
        cpm: bid.status === 'received' ? bid.cpmUsd : null,
        responseTime: bid.responseTime || null,
        isKargo: bid.isKargo || false,
        won: bid.won || false,
      })),
      winningBidder: auctionCache.winningBids[code]?.bidder || null,
      winningCpm: auctionCache.winningBids[code]?.cpmUsd || null,
    })),

    // Errors (for debugging)
    errors: auctionCache.errors || [],
  };
}

/**
 * Formats the win payload for sending
 */
function formatWinPayload(auctionId, adUnitCode, auctionCache) {
  const winningBid = auctionCache.winningBids[adUnitCode];
  if (!winningBid) return null;

  const adUnit = auctionCache.adUnits[adUnitCode];
  const kargoBid = adUnit
    ? Object.values(adUnit.bids).find(b => b.isKargo)
    : null;

  return {
    version: ANALYTICS_VERSION,
    timestamp: Date.now(),
    auctionId,
    adUnitCode,
    winner: {
      bidder: winningBid.bidder,
      cpm: winningBid.cpm,
      cpmUsd: winningBid.cpmUsd,
    },
    kargo: kargoBid ? {
      participated: true,
      cpm: kargoBid.cpmUsd,
      margin: winningBid.cpmUsd && kargoBid.cpmUsd
        ? parseFloat((winningBid.cpmUsd - kargoBid.cpmUsd).toFixed(3))
        : null,
      rank: calculateRank(adUnit, kargoBid.cpmUsd),
    } : {
      participated: false,
      cpm: null,
      margin: null,
      rank: null,
    },
  };
}

/// /////////// DATA TRANSMISSION //////////////

/**
 * Sends auction analytics data
 */
function sendAuctionAnalytics(auctionId) {
  const auctionCache = cache.auctions[auctionId];
  if (!auctionCache || auctionCache.sent) return;

  // Check sampling
  if (!_sampled) {
    auctionCache.sent = true;
    cleanupAuction(auctionId);
    return;
  }

  const payload = formatAuctionPayload(auctionId, auctionCache);

  try {
    ajax(
      `${ENDPOINT_BASE}/auction`,
      {
        success: () => {
          auctionCache.sent = true;
          cleanupAuction(auctionId);
        },
        error: (err) => {
          logError(LOG_PREFIX + 'Failed to send auction analytics:', err);
          auctionCache.sent = true;
          cleanupAuction(auctionId);
        }
      },
      JSON.stringify(payload),
      {
        method: 'POST',
        contentType: 'application/json',
      }
    );
  } catch (err) {
    logError(LOG_PREFIX + 'Error sending auction analytics:', err);
    auctionCache.sent = true;
    cleanupAuction(auctionId);
  }
}

/**
 * Sends individual win analytics data
 */
function sendWinAnalytics(auctionId, adUnitCode) {
  const auctionCache = cache.auctions[auctionId];
  if (!auctionCache) return;

  // Check sampling
  if (!_sampled) return;

  const payload = formatWinPayload(auctionId, adUnitCode, auctionCache);
  if (!payload) return;

  try {
    ajax(
      `${ENDPOINT_BASE}/win`,
      null,
      JSON.stringify(payload),
      {
        method: 'POST',
        contentType: 'application/json',
      }
    );
  } catch (err) {
    logError(LOG_PREFIX + 'Error sending win analytics:', err);
  }
}

/**
 * Cleans up auction cache after sending
 */
function cleanupAuction(auctionId) {
  // Delay cleanup to allow for any late events
  setTimeout(() => {
    delete cache.auctions[auctionId];
  }, 30000); // 30 seconds
}

/// /////////// ADAPTER DEFINITION //////////////

const baseAdapter = adapter({ analyticsType: 'endpoint' });

const kargoAnalyticsAdapter = Object.assign({}, baseAdapter, {
  /**
   * Enable analytics with configuration
   */
  enableAnalytics(config) {
    const options = config?.options || {};

    _config = {
      ...DEFAULT_CONFIG,
      ...options,
    };

    // Validate sampling rate
    if (_config.sampling < 1 || _config.sampling > 100) {
      logWarn(LOG_PREFIX + 'Invalid sampling rate, using 100%');
      _config.sampling = 100;
    }

    // Determine if this session is sampled
    _sampled = shouldSample();

    baseAdapter.enableAnalytics.call(this, config);
  },

  /**
   * Disable analytics and clean up
   */
  disableAnalytics() {
    _config = { ...DEFAULT_CONFIG };
    _sampled = true;
    // Clear cache
    Object.keys(cache.auctions).forEach(key => delete cache.auctions[key]);
    baseAdapter.disableAnalytics.apply(this, arguments);
  },

  /**
   * Track Prebid events
   */
  track({ eventType, args }) {
    const handler = eventHandlers[eventType];
    if (handler) {
      try {
        handler(args);
      } catch (err) {
        logError(LOG_PREFIX + `Error handling ${eventType}:`, err);
      }
    }
  },
});

/// /////////// ADAPTER REGISTRATION //////////////

adapterManager.registerAnalyticsAdapter({
  adapter: kargoAnalyticsAdapter,
  code: ADAPTER_CODE,
});

export default kargoAnalyticsAdapter;
