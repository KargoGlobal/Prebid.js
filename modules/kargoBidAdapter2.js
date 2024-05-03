import { isEmpty, buildUrl, deepAccess, triggerPixel, mergeDeep, deepSetValue, isStr, isArray, isNumber, isBoolean } from '../src/utils.js';
import { registerBidder } from '../src/adapters/bidderFactory.js';
import { getStorageManager } from '../src/storageManager.js';
import { BANNER, VIDEO } from '../src/mediaTypes.js';
import { ortbConverter } from '../libraries/ortbConverter/converter.js';

const PREBID_VERSION = '$prebid.version$'

const BIDDER = Object.freeze({
  CODE: 'kargo2',
  HOST: 'krk2.kargo.com',
  REQUEST_METHOD: 'POST',
  REQUEST_ENDPOINT: '/api/v1/prebid',
  TIMEOUT_ENDPOINT: '/api/v1/event/timeout',
  GVLID: 972,
  SUPPORTED_MEDIA_TYPES: [BANNER, VIDEO],
});

const STORAGE = getStorageManager({bidderCode: BIDDER.CODE});

const CURRENCY = Object.freeze({
  US_DOLLAR: 'USD',
});

const REQUEST_KEYS = Object.freeze({
  SOCIAL_CANVAS: 'params.socialCanvas',
});

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
  return !(isEmpty(bid) || isEmpty(bid.params) || isEmpty(bid.params.placementId));
}

function addUserIds(request, context) {
  // Add the sharedIDEids
  const userEids = context.userIdAsEids;
  if (isArray(userEids) && !isEmpty(userEids)) { deepSetValue(request, 'user.sharedIDEids', userEids); }

  // Add in the CRB information
  const crb = _getCrb();
  if (!isEmpty(crb.syncIds)) { deepSetValue(request, 'user.crbIDs', crb.syncIds); }

  // Add the specific CRB IDs
  if (isStr(crb.lexId)) { deepSetValue(request, 'user.kargoID', crb.lexId); }
  if (isStr(crb.clientId)) { deepSetValue(request, 'user.clientID', crb.clientId); }
  if (isBoolean(crb.optOut)) { deepSetValue(request, 'user.optOut', crb.optOut); }

  // Add in The Trade Desk ID
  if (isStr(context.tdidAdapter)) { deepSetValue(request, 'user.tdID', context.tdidAdapter); } else if (isStr(crb.tdID)) { deepSetValue(request, 'user.tdID', crb.tdID); }
}

const converter = ortbConverter({
  context: {
    netRevenue: true,
    ttl: 300,
  },
  imp(buildImp, bidRequest, context) {
    const imp = buildImp(bidRequest, context);

    // Add the placement ID and transaction ID
    imp.pid = bidRequest.params.placementId;
    const tid = deepAccess(imp, 'ext.tid');
    if (!isEmpty(tid)) { imp.tid = tid; }

    // Add the GPID in the custom spot
    const gpid = deepAccess(bidRequest, 'ortb2Imp.ext.gpid') || deepAccess(bidRequest, 'ortb2Imp.ext.data.pbadslot');
    if (gpid) {
      imp.fpd = { gpid: gpid };
    }

    // Add the custom floor format to the impression
    if (isNumber(imp.bidfloor) && imp.bidfloorcur === 'USD') { imp.floor = imp.bidfloor; }

    // Add the raw data as expected by the endpoint
    // @TODO - change the API so this isn't needed?
    if (bidRequest.mediaTypes) {
      const { banner, video } = bidRequest.mediaTypes;
      if (!isEmpty(banner)) { imp.banner = mergeDeep({}, imp.banner, banner); }
      if (!isEmpty(video)) { imp.video = mergeDeep({}, imp.video, video); }
    }

    return imp;
  },
  request(buildRequest, imps, bidderRequest, context) {
    const request = buildRequest(imps, bidderRequest, context);

    // Add custom consistent values
    mergeDeep(request, {
      pbv: PREBID_VERSION,
      url: request.site.page,
      sid: _getSessionId(),
      requestCount: getRequestCount(request.site.page),
      timeout: request.tmax,
      ts: Date.now(),
    });

    // Add the auction ID if present
    if (!isEmpty(bidderRequest.auctionId)) { request.aid = bidderRequest.auctionId; }

    // Add the custom ortb2 passthrough
    const ortb2Passthrough = {};
    if (!isEmpty(request.bcat)) { ortb2Passthrough.bcat = request.bcat; }
    if (!isEmpty(request.badv)) { ortb2Passthrough.badv = request.badv; }
    if (isNumber(request.cattax)) { ortb2Passthrough.cattax = request.cattax; }
    if (!isEmpty(ortb2Passthrough)) { deepSetValue(request, 'ext.ortb2', ortb2Passthrough); }

    // Add custom currency
    if (!isEmpty(request.cur) && request.cur[0] !== CURRENCY.US_DOLLAR) {
      request.cur = request.cur[0];
    } else {
      delete request.cur;
    }

    // Add custom raw cerberus values
    const rawCRB = STORAGE.getCookie(CERBERUS.KEY);
    if (rawCRB !== null) { request.rawCRB = rawCRB; }
    const rawCRBLocalStorage = STORAGE.getDataFromLocalStorage(CERBERUS.KEY);
    if (rawCRBLocalStorage !== null) { request.rawCRBLocalStorage = rawCRBLocalStorage; }

    // Add custom page object
    const page = {};
    const pageId = STORAGE.getDataFromLocalStorage(CERBERUS.PAGE_VIEW_ID);
    const pageTimestamp = STORAGE.getDataFromLocalStorage(CERBERUS.PAGE_VIEW_TIMESTAMP);
    const pageUrl = STORAGE.getDataFromLocalStorage(CERBERUS.PAGE_VIEW_URL);
    if (!isEmpty(pageId)) { page.id = pageId; }
    if (!isEmpty(pageTimestamp)) { page.timestamp = Number(pageTimestamp); }
    if (!isEmpty(pageUrl)) { page.url = pageUrl; }
    if (!isEmpty(page)) { request.page = page; }

    // Add custom schain object
    if (!isEmpty(context.schain) && !isEmpty(context.schain.nodes)) { request.schain = context.schain; }

    // Add the custom socan parameters
    if (!isEmpty(context.socialCanvas)) { request.socan = context.socialCanvas; }

    // Add the USP consent to the user object
    if (isStr(bidderRequest.uspConsent)) { deepSetValue(request, 'user.usp', bidderRequest.uspConsent); }

    // Add the GDPR consent to the user object
    if (!isEmpty(bidderRequest.gdprConsent)) {
      deepSetValue(request, 'user.gdpr.consent', bidderRequest.gdprConsent.consentString || '');
      deepSetValue(request, 'user.gdpr.applies', !!bidderRequest.gdprConsent.gdprApplies);
    }

    // Add the GPP consent to the user object
    if (!isEmpty(bidderRequest.gppConsent)) {
      const parsedGPP = {};
      if (!isEmpty(bidderRequest.gppConsent.consentString)) { parsedGPP.gppString = bidderRequest.gppConsent.consentString; }
      if (!isEmpty(bidderRequest.gppConsent.applicableSections)) { parsedGPP.applicableSections = bidderRequest.gppConsent.applicableSections; }
      if (!isEmpty(parsedGPP)) { deepSetValue(request, 'user.gpp', parsedGPP); }
    }

    // Add the user IDs
    addUserIds(request, context);

    request.v = 'NEW';

    return request;
  }
});
function buildRequests(bidRequests, bidderRequest) {
  const context = {
    userIdAsEids: deepAccess(bidRequests, '0.userIdAsEids'),
    socialCanvas: deepAccess(bidRequests[0], REQUEST_KEYS.SOCIAL_CANVAS),
    schain: bidRequests[0].schain,
    tdidAdapter: deepAccess(bidRequests, '0.userId.tdid'),
  };
  let data = converter.toORTB({ bidRequests, bidderRequest, context });

  return Object.assign({}, bidderRequest, {
    method: BIDDER.REQUEST_METHOD,
    url: `https://${BIDDER.HOST}${BIDDER.REQUEST_ENDPOINT}`,
    data,
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
    return JSON.parse(atob(STORAGE.getDataFromLocalStorage(CERBERUS.KEY)));
  } catch (e) {
    return {};
  }
}

function getClientId() {
  const crb = spec._getCrb();
  return crb.clientId;
}

function getRequestCount(newUrl) {
  if (lastPageUrl === newUrl) {
    return ++requestCounter;
  }
  lastPageUrl = newUrl;
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
  _getSessionId,
};

registerBidder(spec);
