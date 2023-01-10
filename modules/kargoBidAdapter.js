import { _each, buildUrl, deepAccess, pick, triggerPixel } from '../src/utils.js';
import { config } from '../src/config.js';
import { registerBidder } from '../src/adapters/bidderFactory.js';
import { getStorageManager } from '../src/storageManager.js';
import { BANNER, VIDEO } from '../src/mediaTypes.js';

const PREBID_VERSION = '$prebid.version$'

const BIDDER = Object.freeze({
  CODE: 'kargo',
  HOST: 'https://krk2.kargo.com',
  REQUEST_METHOD: 'POST',
  REQUEST_ENDPOINT: '/api/v1/prebid',
  GVLID: 972,
  SUPPORTED_MEDIA_TYPES: [BANNER, VIDEO],
});

const STORAGE = getStorageManager({gvlid: BIDDER.GVLID, bidderCode: BIDDER.CODE});

const CURRENCY = Object.freeze({
  KEY: 'currency',
  US_DOLLAR: 'USD',
});

const REQUEST_KEYS = Object.freeze({
  SOCIAL_CANVAS: 'params.socialCanvas',
  SUA: 'ortb2.device.sua',
  TDID: 'userId.tdid',
});

const SUA = Object.freeze({
  BROWSERS: 'browsers',
  MOBILE: 'mobile',
  MODEL: 'model',
  PLATFORM: 'platform',
  SOURCE: 'source',
});

const SUA_ATTRIBUTES = [
  SUA.BROWSERS,
  SUA.MOBILE,
  SUA.MODEL,
  SUA.SOURCE,
  SUA.PLATFORM,
];

const CERBERUS = Object.freeze({
  KEY: 'krg_crb',
  SYNC_URL: 'https://crb.kargo.com/api/v1/initsyncrnd/{UUID}?seed={SEED}&idx={INDEX}&gdpr={GDPR}&gdpr_consent={GDPR_CONSENT}&us_privacy={US_PRIVACY}',
  SYNC_COUNT: 5,
  PAGE_VIEW_ID: 'pageViewId',
  PAGE_VIEW_TIMESTAMP: 'pageViewTimestamp',
  PAGE_VIEW_URL: 'pageViewUrl'
});

let sessionId,
  lastPageUrl,
  requestCounter;

function isBidRequestValid(bid) {
  if (!bid || !bid.params) {
    return false;
  }

  return !!bid.params.placementId;
}

function buildRequests(validBidRequests, bidderRequest) {
  const currencyObj = config.getConfig(CURRENCY.KEY);
  const currency = (currencyObj && currencyObj.adServerCurrency) ? currencyObj.adServerCurrency : null;
  const impressions = [];

  _each(validBidRequests, bid => {
    impressions.push(getImpression(bid))
  });

  const firstBidRequest = validBidRequests[0];
  const tdid = deepAccess(firstBidRequest, REQUEST_KEYS.TDID)

  const krakenParams = Object.assign({}, {
    pbv: PREBID_VERSION,
    aid: firstBidRequest.auctionId,
    sid: spec._getSessionId(),
    url: spec._getAllMetadata(bidderRequest).pageURL,
    timeout: bidderRequest.timeout,
    ts: new Date().getTime(),
    device: {
      size: [
        window.screen.width,
        window.screen.height
      ]
    },
    imp: impressions,
    user: spec._getUserIds(tdid, bidderRequest.uspConsent, bidderRequest.gdprConsent, firstBidRequest.userIdAsEids)
  });

  const reqCount = spec._getRequestCount()
  if (reqCount != null && reqCount > 0) {
    krakenParams.requestCount = reqCount
  }

  if (currency != null && currency != CURRENCY.US_DOLLAR) {
    krakenParams.cur = currency
  }

  // Pull Social Canvas segments and embed URL
  const socialCanvas = deepAccess(firstBidRequest, REQUEST_KEYS.SOCIAL_CANVAS);

  if (socialCanvas != null) {
    krakenParams.socan = socialCanvas
  }

  // User Agent Client Hints / SUA
  const uaClientHints = deepAccess(firstBidRequest, REQUEST_KEYS.SUA);
  if (uaClientHints) {
    const suaValidAttributes = []

    for (const suaKey of SUA_ATTRIBUTES) {
      const suaValue = uaClientHints[suaKey]
      if(!suaValue) {
        continue
      }

      // Do not pass any empty strings
      if(typeof suaValue == 'string' && suaValue.trim() === '') {
        continue
      }

      switch (suaKey) {
        case SUA.MOBILE, SUA.SOURCE:
          if (suaValue < 1) {
            return;
          };
        default:
          suaValidAttributes.push(suaKey);
      }
    }

    krakenParams.device.sua = pick(uaClientHints, suaValidAttributes);
  }

  const validPageId = spec._getLocalStorageSafely(CERBERUS.PAGE_VIEW_ID) != null 
  const validPageTimestamp = spec._getLocalStorageSafely(CERBERUS.PAGE_VIEW_TIMESTAMP) != null
  const validPageUrl = spec._getLocalStorageSafely(CERBERUS.PAGE_VIEW_URL) != null

  const page = {}
  if(validPageId) {
    page.id = spec._getLocalStorageSafely(CERBERUS.PAGE_VIEW_ID)
  }
  if(validPageTimestamp) {
    page.timestamp = Number(spec._getLocalStorageSafely(CERBERUS.PAGE_VIEW_TIMESTAMP))
  }
  if(validPageUrl) {
    page.url = spec._getLocalStorageSafely(CERBERUS.PAGE_VIEW_URL)
  }
  if (!_.isEmpty(page)) {
    krakenParams.page = page
  }
  
  return Object.assign({}, bidderRequest, {
    method: BIDDER.REQUEST_METHOD,
    url: `${BIDDER.HOST}${BIDDER.REQUEST_ENDPOINT}`,
    data: krakenParams,
    currency: currency
  });
}

function interpretResponse(response, bidRequest) {
  let bids = response.body;
  const bidResponses = [];
  for (let bidId in bids) {
    let adUnit = bids[bidId];
    let meta = {
      mediaType: BANNER
    };

    if (adUnit.metadata && adUnit.metadata.landingPageDomain) {
      meta.clickUrl = adUnit.metadata.landingPageDomain[0];
      meta.advertiserDomains = adUnit.metadata.landingPageDomain;
    }

    if (adUnit.mediaType && BIDDER.SUPPORTED_MEDIA_TYPES.includes(adUnit.mediaType)) {
      meta.mediaType = adUnit.mediaType;
    }

    const bidResponse = {
      ad: adUnit.adm,
      requestId: bidId,
      cpm: Number(adUnit.cpm),
      width: adUnit.width,
      height: adUnit.height,
      ttl: 300,
      creativeId: adUnit.id,
      dealId: adUnit.targetingCustom,
      netRevenue: true,
      currency: adUnit.currency || bidRequest.currency,
      mediaType: meta.mediaType,
      meta: meta
    };

    if (meta.mediaType == VIDEO) {
      bidResponse.vastXml = adUnit.adm;
    }

    bidResponses.push(bidResponse);
  }

  return bidResponses;
}

function getUserSyncs(syncOptions, responses, gdprConsent, usPrivacy) {
  const syncs = [];
  const seed = spec._generateRandomUuid();
  const clientId = spec._getClientId();
  var gdpr = (gdprConsent && gdprConsent.gdprApplies) ? 1 : 0;
  var gdprConsentString = (gdprConsent && gdprConsent.consentString) ? gdprConsent.consentString : '';
  // don't sync if opted out via usPrivacy
  if (typeof usPrivacy == 'string' && usPrivacy.length == 4 && usPrivacy[0] == 1 && usPrivacy[2] == 'Y') {
    return syncs;
  }
  if (syncOptions.iframeEnabled && seed && clientId) {
    for (let i = 0; i < CERBERUS.SYNC_COUNT; i++) {
      syncs.push({
        type: 'iframe',
        url: CERBERUS.SYNC_URL.replace('{UUID}', clientId)
          .replace('{SEED}', seed)
          .replace('{INDEX}', i)
          .replace('{GDPR}', gdpr)
          .replace('{GDPR_CONSENT}', gdprConsentString)
          .replace('{US_PRIVACY}', usPrivacy || '')
      });
    }
  }
  return syncs;
}

function onTimeout(timeoutData) {
  if (timeoutData == null) {
    return;
  }

  timeoutData.forEach((bid) => {
    this._sendTimeoutData(bid.auctionId, bid.timeout);
  });
}

function _getCrbFromCookie() {
  try {
    const crb = JSON.parse(STORAGE.getCookie(CERBERUS.KEY));
    if (crb && crb.v) {
      let vParsed = JSON.parse(atob(crb.v));
      if (vParsed) {
        return vParsed;
      }
    }
    return {};
  } catch (e) {
    return {};
  }
}

function _getCrbFromLocalStorage() {
  try {
    return JSON.parse(atob(spec._getLocalStorageSafely(CERBERUS.KEY)));
  } catch (e) {
    return {};
  }
}

function _getCrb() {
  let localStorageCrb = spec._getCrbFromLocalStorage();
  if (Object.keys(localStorageCrb).length) {
    return localStorageCrb;
  }
  return spec._getCrbFromCookie();
}

function _getLocalStorageSafely(key) {
  try {
    return STORAGE.getDataFromLocalStorage(key);
  } catch (e) {
    return null;
  }
}

function _getUserIds(tdid, usp, gdpr, eids) {
  const crb = spec._getCrb();
  const userIds = {
    crbIDs: crb.syncIds || {}
  };

  if (tdid) {
    userIds.tdID = tdid;
  }

  if(usp) {
    userIds.usp = usp
  }

  try {
    if (gdpr) {
      userIds['gdpr'] = {
        consent: gdpr.consentString || '',
        applies: !!gdpr.gdprApplies,
      }
    }
  } catch (e) {
  }
  
  if(crb.lexId != null) {
    userIds.kargoID = crb.lexId
  }

  if(crb.clientId !=  null) {
    userIds.clientID = crb.clientId
  }

  if(crb.optOut != null) {
    userIds.optOut = crb.optOut
  }

  if(eids != null) {
    userIds.eids = eids
  }

  return userIds;
}

function _getClientId() {
  const crb = spec._getCrb();
  return crb.clientId;
}

function _getAllMetadata(bidderRequest) {
  return {
    pageURL: bidderRequest?.refererInfo?.page,
    rawCRB: STORAGE.getCookie(CERBERUS.KEY),
    rawCRBLocalStorage: spec._getLocalStorageSafely(CERBERUS.KEY)
  };
}

function _getSessionId() {
  if (!sessionId) {
    sessionId = spec._generateRandomUuid();
  }
  return sessionId;
}

function _getRequestCount() {
  if (lastPageUrl === window.location.pathname) {
    return ++requestCounter;
  }
  lastPageUrl = window.location.pathname;
  return requestCounter = 0;
}

function _generateRandomUuid() {
  try {
    // crypto.getRandomValues is supported everywhere but Opera Mini for years
    var buffer = new Uint8Array(16);
    crypto.getRandomValues(buffer);
    buffer[6] = (buffer[6] & ~176) | 64;
    buffer[8] = (buffer[8] & ~64) | 128;
    var hex = Array.prototype.map.call(new Uint8Array(buffer), function(x) {
      return ('00' + x.toString(16)).slice(-2);
    }).join('');
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
  } catch (e) {
    return '';
  }
}

function _sendTimeoutData(auctionId, auctionTimeout) {
  let params = {
    aid: auctionId,
    ato: auctionTimeout,
  };

  try {
    let timeoutRequestUrl = buildUrl({
      protocol: 'https',
      hostname: 'krk.kargo.com',
      pathname: '/api/v1/event/timeout',
      search: params
    });

    triggerPixel(timeoutRequestUrl);
  } catch (e) {}
}

function getImpression(bid) {
  const imp = {
    id: bid.bidId,
    tid: bid.transactionId,
    pid: bid.params.placementId,
    code: bid.adUnitCode
  }

  if (bid.floorData != null && bid.floorData.floorMin > 0) {
    imp.floor = bid.floorData.floorMin
  }

  if (bid.bidRequestsCount > 0) {
    imp.bidRequestCount = bid.bidRequestsCount
  }

  if (bid.bidderRequestsCount > 0) {
    imp.bidderRequestCount = bid.bidderRequestsCount
  }

  if (bid.bidderWinsCount > 0) {
    imp.bidderWinCount = bid.bidderWinsCount
  }

  const gpid = getGPID(bid)
  if (gpid != null && gpid != '') {
    imp.fpd = {
      gpid: gpid
    }
  }

  if(bid.mediaTypes != null) {
    if (bid.mediaTypes.banner != null) {
      imp.banner = bid.mediaTypes.banner
    }

    if (bid.mediaTypes.video != null) {
      imp.video = bid.mediaTypes.video
    }

    if (bid.mediaTypes.native != null) {
      imp.native = bid.mediaTypes.native
    }
  }

  return imp
}

function getGPID(bid) {
  if (bid.ortb2Imp != null) {
    if (bid.ortb2Imp.gpid != null & bid.ortb2Imp.gpid != '') {
      return bid.ortb2Imp.gpid
    }

    if (bid.ortb2Imp.ext != null && bid.ortb2Imp.ext.data != null) {
      if (bid.ortb2Imp.ext.data.pbAdSlot != null && bid.ortb2Imp.ext.data.pbAdSlot != '') {
        return bid.ortb2Imp.ext.data.pbAdSlot
      }

      if (bid.ortb2Imp.ext.data.adServer.adSlot != null && bid.ortb2Imp.ext.data.adServer.adSlot != '') {
        return bid.ortb2Imp.ext.data.adServer.adSlot
      }
    }
  }

  if (bid.adUnitCode != null && bid.adUnitCode != '') {
    return bid.adUnitCode
  }
  return ''
}

export const spec = {
  gvlid: BIDDER.GVLID,
  code: BIDDER.CODE,
  isBidRequestValid,
  buildRequests,
  interpretResponse,
  getUserSyncs,
  supportedMediaTypes: BIDDER.SUPPORTED_MEDIA_TYPES,
  onTimeout,
  _getCrbFromCookie,
  _getCrbFromLocalStorage,
  _getCrb,
  _getLocalStorageSafely,
  _getUserIds,
  _getClientId,
  _getAllMetadata,
  _getSessionId,
  _getRequestCount,
  _generateRandomUuid,
  _sendTimeoutData
};

registerBidder(spec);
