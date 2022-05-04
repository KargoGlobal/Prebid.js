import kargoAnalyticsAdapter from 'modules/kargoAnalyticsAdapter.js';
import { expect } from 'chai';
import { server } from 'test/mocks/xhr.js';
let events = require('src/events');
let constants = require('src/constants.json');

describe('Kargo Analytics Adapter', function () {
  const adapterConfig = {
    provider: 'kargoAnalytics',
    options: {
      bundleId: '',
      account: 'kargo',
    },
  };

  after(function () {
    kargoAnalyticsAdapter.disableAnalytics();
  });

  describe('main test flow', function () {
    beforeEach(function () {
      kargoAnalyticsAdapter.enableAnalytics(adapterConfig);
      sinon.stub(events, 'getEvents').returns([]);
    });

    afterEach(function () {
      events.getEvents.restore();
    });

    it('bid timeout should send one request', function() {
      const bidTimeout = [
        {
          bidId: '2baa51527bd015',
          bidder: 'kargo',
          adUnitCode: '/19968336/header-bid-tag-0',
          auctionId: '66529d4c-8998-47c2-ab3e-5b953490b98f'
        },
        {
          bidId: '6fe3b4c2c23092',
          bidder: 'kargo',
          adUnitCode: '/19968336/header-bid-tag-1',
          auctionId: '66529d4c-8998-47c2-ab3e-5b953490b98f'
        }
      ];
      events.emit(constants.EVENTS.AUCTION_INIT, {
        timeout: 100
      });
      events.emit(constants.EVENTS.BID_TIMEOUT, bidTimeout);

      expect(server.requests[0].url).to.equal('https://krk.kargo.com/api/v1/event/timeout?aid=66529d4c-8998-47c2-ab3e-5b953490b98f&ato=100');
      expect(server.requests.length).to.equal(1);
    });
  });
});
