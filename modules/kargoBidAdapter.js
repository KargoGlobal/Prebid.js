import { _each, isEmpty, buildUrl, deepAccess, pick, triggerPixel, logError, isStr, isNumber, deepSetValue, isArray, isInteger, isPlainObject, isBoolean, isArrayOfNums, logWarn, uniques } from '../src/utils.js';
import { config } from '../src/config.js';
import { registerBidder } from '../src/adapters/bidderFactory.js';
import { getStorageManager } from '../src/storageManager.js';
import { BANNER, VIDEO } from '../src/mediaTypes.js';

const PREBID_VERSION = '$prebid.version$'

const BIDDER = Object.freeze({
  CODE: 'kargo',
  HOST: 'krk2.kargo.com',
  REQUEST_METHOD: 'POST',
  REQUEST_ENDPOINT: '/api/v1/prebid',
  TIMEOUT_ENDPOINT: '/api/v1/event/timeout',
  GVLID: 972,
  SUPPORTED_MEDIA_TYPES: [BANNER, VIDEO],
});

const STORAGE = getStorageManager({bidderCode: BIDDER.CODE});

const CURRENCY = Object.freeze({
  KEY: 'currency',
  US_DOLLAR: 'USD',
});

const REQUEST_KEYS = Object.freeze({
  USER_DATA: '0.ortb2.user.data',
  SOCIAL_CANVAS: '0.params.socialCanvas',
  SUA: '0.ortb2.device.sua',
  TDID_ADAPTER: '0.userId.tdid',
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
  SYNC_URL: 'https://crb.kargo.com/api/v1/initsyncrnd/{UUID}?seed={SEED}&idx={INDEX}&gdpr={GDPR}&gdpr_consent={GDPR_CONSENT}&us_privacy={US_PRIVACY}&gpp={GPP_STRING}&gpp_sid={GPP_SID}',
  SYNC_COUNT: 5,
  PAGE_VIEW_ID: 'pageViewId',
  PAGE_VIEW_TIMESTAMP: 'pageViewTimestamp',
  PAGE_VIEW_URL: 'pageViewUrl'
});

let sessionId,
  lastPageUrl,
  requestCounter;

function isBidRequestValid(bid) {
  if (!bid) return false;

  if (!isPlainObject(bid.params) || isEmpty(bid.params)) return false;

  const validPlacementId = isStr(bid.params.placementId) &&
    bid.params.placementId.trim() !== '' &&
    bid.params.placementId[0] === '_';

  if (!validPlacementId) {
    logError('Kargo: Invalid placement ID. Placement ID must be passed as `placementId` and be a string that starts with an underscore');
  }

  return validPlacementId;
}

function isArrayOfStrs(val) {
  if (!isArray(val)) return false;

  return val.every(v => isStr(v));
}

function buildRequests(validBidRequests, bidderRequest) {
  const improperTypes = []
  const impressions = [];

  _each(validBidRequests, bid => {
    impressions.push(getImpression(bid, improperTypes))
  });

  const metadata = getAllMetadata(bidderRequest);

  const krakenParams = Object.assign({}, {
    pbv: PREBID_VERSION,
    sid: _getSessionId(),
    ts: new Date().getTime(),
    imp: impressions,
    requestCount: getRequestCount(),
    user: {
      crbIDs: {},
      data: [],
    },
  });

  // Directly modifies krakenParams
  setUserIds(krakenParams, validBidRequests, bidderRequest, improperTypes);

  // Add the auction ID if it is a string
  const aid = deepAccess(validBidRequests, '0.auctionId', null);
  if (isStr(aid) && !isEmpty(aid)) {
    krakenParams.aid = aid;
  } else if (aid !== null) {
    improperTypes.push('validBidRequests.0.auctionId');
  }

  // Add the page URL if it is a string
  const pageUrl = deepAccess(bidderRequest, 'refererInfo.page', null);
  if (isStr(pageUrl) && !isEmpty(pageUrl)) {
    krakenParams.url = pageUrl;
  } else if (pageUrl !== null) {
    improperTypes.push('bidderRequest.refererInfo.page');
  }

  // Add the window size (if it is available)
  const winWidth = deepAccess(window, 'screen.width');
  const winHeight = deepAccess(window, 'screen.height');
  if (isNumber(winWidth) && isNumber(winHeight)) {
    deepSetValue(krakenParams, 'device.size', [ winWidth, winHeight ]);
  }

  // Add the timeout if it is a number
  const timeout = deepAccess(bidderRequest, 'timeout', null);
  if (isNumber(timeout)) {
    krakenParams.timeout = timeout;
  } else if (timeout !== null) {
    improperTypes.push('bidderRequest.timeout');
  }

  // Add site.cat, bcat, badv, and cattax to the request
  const firstBidRequestOrtb = deepAccess(validBidRequests, '0.ortb2', null);
  if (!isEmpty(firstBidRequestOrtb)) {
    const siteCat = deepAccess(firstBidRequestOrtb, 'site.cat', null);
    if (
      isArrayOfStrs(siteCat) &&
      !isEmpty(siteCat)
    ) {
      deepSetValue(krakenParams, 'site.cat', siteCat);
    } else if (siteCat !== null) {
      improperTypes.push('validBidRequests.0.ortb2.site.cat');
    }

    const bcat = deepAccess(firstBidRequestOrtb, 'bcat', null);
    if (isArrayOfStrs(bcat) && !isEmpty(bcat)) {
      deepSetValue(krakenParams, 'ext.ortb2.bcat', bcat);
    } else if (bcat !== null) {
      improperTypes.push('validBidRequests.0.ortb2.bcat');
    }

    const badv = deepAccess(firstBidRequestOrtb, 'badv', null);
    if (isArrayOfStrs(badv) && !isEmpty(badv)) {
      deepSetValue(krakenParams, 'ext.ortb2.badv', badv);
    } else if (badv !== null) {
      improperTypes.push('validBidRequests.0.ortb2.badv');
    }

    const cattax = deepAccess(firstBidRequestOrtb, 'cattax', null);
    if (isNumber(cattax) && isInteger(cattax)) {
      deepSetValue(krakenParams, 'ext.ortb2.cattax', cattax);
    } else if (cattax !== null) {
      improperTypes.push('validBidRequests.0.ortb2.cattax');
    }

    // Alternative:
    // deepSetValue(krakenParams, 'ext.ortb2', firstBidRequestOrtb);
  }

  // Add schain
  const schain = deepAccess(validBidRequests, '0.schain', null);
  if (
    isPlainObject(schain) &&
    !isEmpty(schain) &&
    !isEmpty(deepAccess(schain, 'nodes'))
  ) {
    krakenParams.schain = schain;
  } else if (schain !== null) {
    improperTypes.push('validBidRequests.0.schain');
  }

  // Add currency if not USD
  const currencyObj = config.getConfig(CURRENCY.KEY);
  const currency = deepAccess(currencyObj, 'adServerCurrency');
  if (isStr(currency) && currency !== CURRENCY.US_DOLLAR) {
    krakenParams.cur = currency;
  }

  if (isStr(metadata.rawCRB)) {
    krakenParams.rawCRB = metadata.rawCRB
  }

  if (isStr(metadata.rawCRBLocalStorage)) {
    krakenParams.rawCRBLocalStorage = metadata.rawCRBLocalStorage
  }

  // Pull Social Canvas segments and embed URL
  const socialCanvas = deepAccess(validBidRequests, REQUEST_KEYS.SOCIAL_CANVAS, null);
  if (isPlainObject(socialCanvas) && !isEmpty(socialCanvas)) {
    if (isArrayOfStrs(socialCanvas.segments) && !isEmpty(socialCanvas.segments)) {
      deepSetValue(krakenParams, 'socan.segments', socialCanvas.segments);
    } else if (typeof socialCanvas.segments !== 'undefined') {
      improperTypes.push('validBidRequests.0.params.socialCanvas.segments');
      logError('Kargo: params.socialCanvas.segments must be an array of strings if provided');
    }
    if (isStr(socialCanvas.url) && !isEmpty(socialCanvas.url)) {
      deepSetValue(krakenParams, 'socan.url', socialCanvas.url);
    } else if (typeof socialCanvas.url !== 'undefined') {
      improperTypes.push('validBidRequests.0.params.socialCanvas.url');
      logError('Kargo: params.socialCanvas.url must be a string if provided');
    }
    if (isStr(socialCanvas.ksoSessionId) && !isEmpty(socialCanvas.ksoSessionId)) {
      deepSetValue(krakenParams, 'socan.ksoSessionId', socialCanvas.ksoSessionId);
    } else if (typeof socialCanvas.ksoSessionId !== 'undefined') {
      improperTypes.push('validBidRequests.0.params.socialCanvas.ksoSessionId');
      logError('Kargo: params.socialCanvas.ksoSessionId must be a string if provided');
    }
    if (isStr(socialCanvas.ksoPageViewId) && !isEmpty(socialCanvas.ksoPageViewId)) {
      deepSetValue(krakenParams, 'socan.ksoPageViewId', socialCanvas.ksoPageViewId);
    } else if (typeof socialCanvas.ksoPageViewId !== 'undefined') {
      improperTypes.push('validBidRequests.0.params.socialCanvas.ksoPageViewId');
      logError('Kargo: params.socialCanvas.ksoPageViewId must be a string if provided');
    }
  }

  // User Agent Client Hints / SUA
  const uaClientHints = deepAccess(validBidRequests, REQUEST_KEYS.SUA);
  if (isPlainObject(uaClientHints) && !isEmpty(uaClientHints)) {
    const suaValidAttributes = []

    SUA_ATTRIBUTES.forEach(suaKey => {
      const suaValue = uaClientHints[suaKey];
      if (!suaValue) {
        return;
      }

      // Do not pass any empty strings
      if (isStr(suaValue) && suaValue.trim() === '') {
        return;
      }

      switch (suaKey) {
        case SUA.MOBILE && suaValue < 1: // Do not pass 0 value for mobile
        case SUA.SOURCE && suaValue < 1: // Do not pass 0 value for source
          break;
        default:
          suaValidAttributes.push(suaKey);
      }
    });

    deepSetValue(krakenParams, 'device.sua', pick(uaClientHints, suaValidAttributes));
  }

  const cerberusPageId = getLocalStorageSafely(CERBERUS.PAGE_VIEW_ID);
  const cerberusPageTimestamp = getLocalStorageSafely(CERBERUS.PAGE_VIEW_TIMESTAMP);
  const cerberusPageUrl = getLocalStorageSafely(CERBERUS.PAGE_VIEW_URL);

  if (isStr(cerberusPageId)) {
    deepSetValue(krakenParams, 'page.id', cerberusPageId);
  }
  if (isStr(cerberusPageTimestamp) && !isNaN(Number(cerberusPageTimestamp))) {
    deepSetValue(krakenParams, 'page.timestamp', Number(cerberusPageTimestamp));
  }
  if (isStr(cerberusPageUrl)) {
    deepSetValue(krakenParams, 'page.url', cerberusPageUrl);
  }

  // Send the type validation failures
  if (!isEmpty(improperTypes)) {
    deepSetValue(
      krakenParams,
      'ext.krg.verr',
      improperTypes.filter(uniques)
    );
  }

  return Object.assign({}, bidderRequest, {
    method: BIDDER.REQUEST_METHOD,
    url: `https://${BIDDER.HOST}${BIDDER.REQUEST_ENDPOINT}`,
    data: krakenParams,
    currency: currency
  });
}

function interpretResponse(response, bidRequest) {
  const bids = response.body;
  const bidResponses = [];

  if (isEmpty(bids) || typeof bids !== 'object') {
    return bidResponses;
  }

  for (const [bidID, adUnit] of Object.entries(bids)) {
    let meta = {
      mediaType: adUnit.mediaType && BIDDER.SUPPORTED_MEDIA_TYPES.includes(adUnit.mediaType) ? adUnit.mediaType : BANNER
    };

    if (adUnit.metadata?.landingPageDomain) {
      meta.clickUrl = adUnit.metadata.landingPageDomain[0];
      meta.advertiserDomains = adUnit.metadata.landingPageDomain;
    }

    const bidResponse = {
      requestId: bidID,
      cpm: Number(adUnit.cpm),
      width: adUnit.width,
      height: adUnit.height,
      ttl: 300,
      creativeId: adUnit.creativeID,
      dealId: adUnit.targetingCustom,
      netRevenue: true,
      currency: adUnit.currency || bidRequest.currency,
      mediaType: meta.mediaType,
      meta: meta
    };

    if (meta.mediaType == VIDEO) {
      if (adUnit.admUrl) {
        bidResponse.vastUrl = adUnit.admUrl;
      } else {
        bidResponse.vastXml = adUnit.adm;
      }
    } else {
      bidResponse.ad = adUnit.adm;
    }

    bidResponses.push(bidResponse);
  }

  return bidResponses;
}

function getUserSyncs(syncOptions, _, gdprConsent, usPrivacy, gppConsent) {
  const syncs = [];
  const seed = _generateRandomUUID();
  const clientId = getClientId();

  var gdpr = (gdprConsent && gdprConsent.gdprApplies) ? 1 : 0;
  var gdprConsentString = (gdprConsent && gdprConsent.consentString) ? gdprConsent.consentString : '';

  var gppString = (gppConsent && gppConsent.consentString) ? gppConsent.consentString : '';
  var gppApplicableSections = (gppConsent && gppConsent.applicableSections && Array.isArray(gppConsent.applicableSections)) ? gppConsent.applicableSections.join(',') : '';

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
          .replace('{GPP_STRING}', gppString)
          .replace('{GPP_SID}', gppApplicableSections)
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
    sendTimeoutData(bid.auctionId, bid.timeout);
  });
}

function _generateRandomUUID() {
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

function _getCrb() {
  let localStorageCrb = getCrbFromLocalStorage();
  if (!isEmpty(localStorageCrb)) {
    return localStorageCrb;
  }
  return getCrbFromCookie();
}

function _getSessionId() {
  if (!sessionId) {
    sessionId = _generateRandomUUID();
  }
  return sessionId;
}

function getCrbFromCookie() {
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

function getCrbFromLocalStorage() {
  try {
    return JSON.parse(atob(getLocalStorageSafely(CERBERUS.KEY)));
  } catch (e) {
    return {};
  }
}

function getLocalStorageSafely(key) {
  try {
    return STORAGE.getDataFromLocalStorage(key);
  } catch (e) {
    return null;
  }
}

function setUserIds(krakenParams, validBidRequests, bidderRequest, improperTypes) {
  const crb = _getCrb();
  if (isPlainObject(crb.syncIds) && !isEmpty(crb.syncIds)) {
    deepSetValue(krakenParams, 'user.crbIDs', crb.syncIds);
  }

  // Pull Trade Desk ID
  const tdidAdapter = deepAccess(validBidRequests, REQUEST_KEYS.TDID_ADAPTER, null);
  let wasTdidValid = false;
  if (isStr(tdidAdapter)) {
    wasTdidValid = true;
    deepSetValue(krakenParams, 'user.tdID', tdidAdapter);
  } else if (isPlainObject(tdidAdapter) && isStr(tdidAdapter.id)) {
    wasTdidValid = true;
    logWarn('Kargo: The ID provided for tdid is improperly formatted as an object not a string');
    deepSetValue(krakenParams, 'user.tdID', tdidAdapter.id);
  } else if (isStr(crb.tdID)) {
    deepSetValue(krakenParams, 'user.tdID', crb.tdID);
  }
  if (tdidAdapter !== null && !wasTdidValid) {
    logError('Kargo: The ID provided for tdid is improperly formatted and not being sent to Kargo bidders');
    improperTypes.push('validBidRequests.0.userId.tdid');
  }

  // Kargo ID
  if (isStr(crb.lexId)) {
    deepSetValue(krakenParams, 'user.kargoID', crb.lexId);
  }

  // Client ID
  if (isStr(crb.clientId)) {
    deepSetValue(krakenParams, 'user.clientID', crb.clientId);
  }

  // Cerberus opt-out
  if (isBoolean(crb.optOut)) {
    deepSetValue(krakenParams, 'user.optOut', crb.optOut);
  }

  // Collect all user ID sub-modules
  const eids = deepAccess(validBidRequests, '0.userIdAsEids');
  if (isArray(eids) && !isEmpty(eids)) {
    deepSetValue(krakenParams, 'user.sharedIDEids', eids);
  }

  // Add user data object if available
  const userData = deepAccess(validBidRequests, REQUEST_KEYS.USER_DATA);
  if (isArray(userData) && !isEmpty(userData)) {
    deepSetValue(krakenParams, 'user.data', userData);
  }

  // USP
  if (isStr(bidderRequest.uspConsent)) {
    deepSetValue(krakenParams, 'user.usp', bidderRequest.uspConsent);
  }

  // GDPR
  if (isPlainObject(bidderRequest.gdprConsent) && !isEmpty(bidderRequest.gdprConsent)) {
    const gdprConfig = {
      consent: deepAccess(bidderRequest, 'gdprConsent.consentString', ''),
      applies: !!deepAccess(bidderRequest, 'gdprConsent.gdprApplies'),
    };
    if (!isStr(gdprConfig.consent)) {
      gdprConfig.consent = '';
    }
    if (!isBoolean(gdprConfig.applies)) {
      gdprConfig.applies = false;
    }
    deepSetValue(krakenParams, 'user.gdpr', gdprConfig);
  }

  // GPP
  if (isPlainObject(bidderRequest.gppConsent) && !isEmpty(bidderRequest.gppConsent)) {
    if (
      isStr(bidderRequest.gppConsent.consentString) &&
      !isEmpty(bidderRequest.gppConsent.consentString)
    ) {
      deepSetValue(krakenParams, 'user.gpp.gppString', bidderRequest.gppConsent.consentString);
    }
    if (
      isArrayOfNums(bidderRequest.gppConsent.applicableSections) &&
      !isEmpty(bidderRequest.gppConsent.applicableSections)
    ) {
      deepSetValue(krakenParams, 'user.gpp.applicableSections', bidderRequest.gppConsent.applicableSections);
    }
  }
}

function getClientId() {
  const crb = spec._getCrb();
  return crb.clientId;
}

function getAllMetadata() {
  return {
    rawCRB: STORAGE.getCookie(CERBERUS.KEY),
    rawCRBLocalStorage: getLocalStorageSafely(CERBERUS.KEY)
  };
}

function getRequestCount() {
  if (lastPageUrl === window.location.pathname) {
    return ++requestCounter;
  }
  lastPageUrl = window.location.pathname;
  return requestCounter = 0;
}

function sendTimeoutData(auctionId, auctionTimeout) {
  let params = {
    aid: auctionId,
    ato: auctionTimeout
  };

  try {
    let timeoutRequestUrl = buildUrl({
      protocol: 'https',
      hostname: BIDDER.HOST,
      pathname: BIDDER.TIMEOUT_ENDPOINT,
      search: params
    });

    triggerPixel(timeoutRequestUrl);
  } catch (e) {}
}

function getImpression(bid, improperTypes) {
  const imp = {
    id: bid.bidId,
    pid: bid.params.placementId, // Validated in isBidRequestValid
  };

  // Add TID
  const tid = deepAccess(bid, 'ortb2Imp.ext.tid', null);
  if (isStr(tid) && !isEmpty(tid)) {
    imp.tid = tid;
  } else if (tid !== null) {
    improperTypes.push('validBidRequests.0.ortb2Imp.ext.tid');
  }

  // Add the code
  const adUnitCode = deepAccess(bid, 'adUnitCode', null);
  if (isStr(adUnitCode) && !isEmpty(adUnitCode)) {
    imp.code = adUnitCode;
  } else if (adUnitCode !== null) {
    improperTypes.push('validBidRequests.0.adUnitCode');
  }

  if (isInteger(bid.bidRequestsCount) && bid.bidRequestsCount > 0) {
    imp.bidRequestCount = bid.bidRequestsCount;
  }

  if (isInteger(bid.bidderRequestsCount) && bid.bidderRequestsCount > 0) {
    imp.bidderRequestCount = bid.bidderRequestsCount;
  }

  if (isInteger(bid.bidderWinsCount) && bid.bidderWinsCount > 0) {
    imp.bidderWinCount = bid.bidderWinsCount;
  }

  const gpid1 = deepAccess(bid, 'ortb2Imp.ext.gpid', null);
  const gpid2 = deepAccess(bid, 'ortb2Imp.ext.data.pbadslot', null);
  const gpid = isStr(gpid1) && !isEmpty(gpid1) ? gpid1 : gpid2;
  if (isStr(gpid) && !isEmpty(gpid)) {
    deepSetValue(imp, 'fpd.gpid', gpid);
  }
  if (gpid1 !== null && (!isStr(gpid1) || isEmpty(gpid1))) {
    improperTypes.push('validBidRequests.0.ortb2Imp.ext.gpid');
  }
  if (gpid2 !== null && (!isStr(gpid2) || isEmpty(gpid2))) {
    improperTypes.push('validBidRequests.0.ortb2Imp.ext.data.pbadslot');
  }

  // Add full ortb2Imp object as backup
  if (isPlainObject(bid.ortb2Imp) && !isEmpty(bid.ortb2Imp)) {
    deepSetValue(imp, 'ext.ortb2Imp', bid.ortb2Imp);
  }

  if (bid.mediaTypes) {
    const { banner, video, native } = bid.mediaTypes;

    if (isPlainObject(banner) && !isEmpty(banner)) {
      imp.banner = banner;
    }

    if (isPlainObject(video) && !isEmpty(video)) {
      imp.video = video;
    }

    if (isPlainObject(native) && !isEmpty(native)) {
      imp.native = native;
    }

    if (typeof bid.getFloor === 'function') {
      let floorInfo;
      try {
        floorInfo = bid.getFloor({
          currency: 'USD',
          mediaType: '*',
          size: '*'
        });
      } catch (e) {
        logError('Kargo: getFloor threw an error: ', e);
      }

      if (
        isPlainObject(floorInfo) &&
        floorInfo.currency === CURRENCY.US_DOLLAR &&
        !isNaN(parseFloat(floorInfo.floor))
      ) {
        imp.floor = parseFloat(floorInfo.floor);
      }
    }
  }

  return imp
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
  _getCrb,
  _getSessionId
};

registerBidder(spec);
