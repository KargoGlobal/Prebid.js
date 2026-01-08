import kargoAnalyticsAdapter from 'modules/kargoAnalyticsAdapter.js';
import { expect } from 'chai';
import { server } from 'test/mocks/xhr.js';
import { EVENTS } from 'src/constants.js';
import adapterManager from 'src/adapterManager.js';

const events = require('src/events');

describe('Kargo Analytics Adapter', function () {
  let clock;

  const defaultAdapterConfig = {
    provider: 'kargo',
    options: {
      sampling: 100,
      sendWinEvents: true,
      sendDelay: 0, // No delay for tests
    },
  };

  const mockAuctionId = '66529d4c-8998-47c2-ab3e-5b953490b98f';
  const mockAdUnitCode = 'div-gpt-ad-123';
  const mockBidId = 'bid-123';

  // Mock auction init args
  const mockAuctionInit = {
    auctionId: mockAuctionId,
    timeout: 1000,
    adUnits: [
      {
        code: mockAdUnitCode,
        mediaTypes: {
          banner: {
            sizes: [[300, 250], [300, 600]]
          }
        }
      }
    ],
    bidderRequests: [
      {
        bidderCode: 'kargo',
        refererInfo: {
          topmostLocation: 'https://example.com/page',
          page: 'https://example.com/page'
        },
        gdprConsent: {
          gdprApplies: true,
          consentString: 'mock-consent-string'
        },
        uspConsent: '1YNN'
      },
      {
        bidderCode: 'appnexus',
        refererInfo: {
          topmostLocation: 'https://example.com/page'
        }
      }
    ]
  };

  // Mock bid requested args
  const mockBidRequested = {
    auctionId: mockAuctionId,
    bidderCode: 'kargo',
    bids: [
      {
        bidId: mockBidId,
        adUnitCode: mockAdUnitCode,
        params: { placementId: 'test-placement' }
      }
    ]
  };

  // Mock bid response args
  const mockBidResponse = {
    auctionId: mockAuctionId,
    adUnitCode: mockAdUnitCode,
    bidder: 'kargo',
    bidderCode: 'kargo',
    requestId: mockBidId,
    cpm: 2.50,
    currency: 'USD',
    timeToRespond: 192,
    mediaType: 'banner',
    width: 300,
    height: 250,
    dealId: null,
    meta: {
      advertiserDomains: ['advertiser.com']
    }
  };

  // Mock auction end args
  const mockAuctionEnd = {
    auctionId: mockAuctionId,
    adUnits: mockAuctionInit.adUnits,
    bidderRequests: mockAuctionInit.bidderRequests
  };

  // Mock bid won args
  const mockBidWon = {
    auctionId: mockAuctionId,
    adUnitCode: mockAdUnitCode,
    bidderCode: 'kargo',
    cpm: 2.50,
    currency: 'USD',
    requestId: mockBidId
  };

  beforeEach(function () {
    clock = sinon.useFakeTimers();
    sinon.stub(events, 'getEvents').returns([]);
  });

  afterEach(function () {
    clock.restore();
    events.getEvents.restore();
    kargoAnalyticsAdapter.disableAnalytics();
  });

  describe('adapter registration', function () {
    it('should register with adapterManager', function () {
      const adapter = adapterManager.getAnalyticsAdapter('kargo');
      expect(adapter).to.exist;
      expect(adapter.adapter).to.equal(kargoAnalyticsAdapter);
    });
  });

  describe('enableAnalytics', function () {
    it('should accept valid config options', function () {
      // Should not throw
      expect(() => kargoAnalyticsAdapter.enableAnalytics(defaultAdapterConfig)).to.not.throw();
    });

    it('should use default config when no options provided', function () {
      // Should not throw
      expect(() => kargoAnalyticsAdapter.enableAnalytics({ provider: 'kargo' })).to.not.throw();
    });
  });

  describe('event handling', function () {
    beforeEach(function () {
      kargoAnalyticsAdapter.enableAnalytics(defaultAdapterConfig);
    });

    describe('AUCTION_INIT', function () {
      it('should initialize auction cache on AUCTION_INIT', function () {
        events.emit(EVENTS.AUCTION_INIT, mockAuctionInit);
        // No immediate request - wait for AUCTION_END
        expect(server.requests.length).to.equal(0);
      });
    });

    describe('BID_REQUESTED', function () {
      it('should track requested bids per ad unit', function () {
        events.emit(EVENTS.AUCTION_INIT, mockAuctionInit);
        events.emit(EVENTS.BID_REQUESTED, mockBidRequested);
        // No immediate request
        expect(server.requests.length).to.equal(0);
      });
    });

    describe('BID_RESPONSE', function () {
      it('should record bid details for Kargo bids', function () {
        events.emit(EVENTS.AUCTION_INIT, mockAuctionInit);
        events.emit(EVENTS.BID_REQUESTED, mockBidRequested);
        events.emit(EVENTS.BID_RESPONSE, mockBidResponse);
        // No immediate request - data is batched
        expect(server.requests.length).to.equal(0);
      });

      it('should handle non-Kargo bid responses', function () {
        events.emit(EVENTS.AUCTION_INIT, mockAuctionInit);
        events.emit(EVENTS.BID_REQUESTED, {
          ...mockBidRequested,
          bidderCode: 'appnexus'
        });
        events.emit(EVENTS.BID_RESPONSE, {
          ...mockBidResponse,
          bidder: 'appnexus',
          bidderCode: 'appnexus',
          cpm: 3.00
        });
        expect(server.requests.length).to.equal(0);
      });
    });

    describe('NO_BID', function () {
      it('should track no-bid responses', function () {
        events.emit(EVENTS.AUCTION_INIT, mockAuctionInit);
        events.emit(EVENTS.BID_REQUESTED, mockBidRequested);
        events.emit(EVENTS.NO_BID, {
          auctionId: mockAuctionId,
          adUnitCode: mockAdUnitCode,
          bidder: 'kargo',
          bidId: mockBidId
        });
        expect(server.requests.length).to.equal(0);
      });
    });

    describe('BID_TIMEOUT', function () {
      it('should track timed out bids', function () {
        events.emit(EVENTS.AUCTION_INIT, mockAuctionInit);
        events.emit(EVENTS.BID_REQUESTED, mockBidRequested);
        events.emit(EVENTS.BID_TIMEOUT, [
          {
            auctionId: mockAuctionId,
            adUnitCode: mockAdUnitCode,
            bidder: 'kargo',
            bidId: mockBidId
          }
        ]);
        expect(server.requests.length).to.equal(0);
      });
    });

    describe('BIDDER_ERROR', function () {
      it('should capture error details', function () {
        events.emit(EVENTS.AUCTION_INIT, mockAuctionInit);
        events.emit(EVENTS.BIDDER_ERROR, {
          auctionId: mockAuctionId,
          bidderCode: 'kargo',
          error: {
            message: 'Server error',
            status: 500
          }
        });
        expect(server.requests.length).to.equal(0);
      });
    });

    describe('AUCTION_END', function () {
      it('should send analytics after AUCTION_END', function () {
        events.emit(EVENTS.AUCTION_INIT, mockAuctionInit);
        events.emit(EVENTS.BID_REQUESTED, mockBidRequested);
        events.emit(EVENTS.BID_RESPONSE, mockBidResponse);
        events.emit(EVENTS.AUCTION_END, mockAuctionEnd);

        // Advance clock past send delay
        clock.tick(1000);

        expect(server.requests.length).to.be.at.least(1);

        const request = server.requests[0];
        expect(request.url).to.equal('https://krk.kargo.com/api/v2/analytics/auction');
        expect(request.method).to.equal('POST');

        const payload = JSON.parse(request.requestBody);
        expect(payload.auctionId).to.equal(mockAuctionId);
        expect(payload.auctionTimeout).to.equal(1000);
        expect(payload.version).to.equal('2.0');
      });

      it('should calculate auction duration', function () {
        events.emit(EVENTS.AUCTION_INIT, mockAuctionInit);
        clock.tick(500); // Simulate 500ms auction
        events.emit(EVENTS.AUCTION_END, mockAuctionEnd);
        clock.tick(1000);

        expect(server.requests.length).to.be.at.least(1);
        const payload = JSON.parse(server.requests[0].requestBody);
        expect(payload.auctionDuration).to.be.a('number');
        expect(payload.auctionDuration).to.be.at.least(500);
      });

      it('should include Kargo-specific metrics', function () {
        events.emit(EVENTS.AUCTION_INIT, mockAuctionInit);
        events.emit(EVENTS.BID_REQUESTED, mockBidRequested);
        events.emit(EVENTS.BID_RESPONSE, mockBidResponse);
        events.emit(EVENTS.AUCTION_END, mockAuctionEnd);
        clock.tick(1000);

        expect(server.requests.length).to.be.at.least(1);
        const payload = JSON.parse(server.requests[0].requestBody);
        expect(payload.kargo).to.exist;
        expect(payload.kargo.bidCount).to.equal(1);
        expect(payload.kargo.bids).to.be.an('array');
        expect(payload.kargo.bids[0].adUnitCode).to.equal(mockAdUnitCode);
      });

      it('should include auction summary', function () {
        events.emit(EVENTS.AUCTION_INIT, mockAuctionInit);
        events.emit(EVENTS.BID_REQUESTED, mockBidRequested);
        events.emit(EVENTS.BID_RESPONSE, mockBidResponse);
        events.emit(EVENTS.AUCTION_END, mockAuctionEnd);
        clock.tick(1000);

        expect(server.requests.length).to.be.at.least(1);
        const payload = JSON.parse(server.requests[0].requestBody);
        expect(payload.auction).to.exist;
        expect(payload.auction.bidderCount).to.be.a('number');
        expect(payload.auction.totalBidsReceived).to.be.a('number');
      });

      it('should include ad unit breakdown', function () {
        events.emit(EVENTS.AUCTION_INIT, mockAuctionInit);
        events.emit(EVENTS.BID_REQUESTED, mockBidRequested);
        events.emit(EVENTS.BID_RESPONSE, mockBidResponse);
        events.emit(EVENTS.AUCTION_END, mockAuctionEnd);
        clock.tick(1000);

        expect(server.requests.length).to.be.at.least(1);
        const payload = JSON.parse(server.requests[0].requestBody);
        expect(payload.adUnits).to.be.an('array');
        expect(payload.adUnits.length).to.be.at.least(1);
        expect(payload.adUnits[0].code).to.equal(mockAdUnitCode);
        expect(payload.adUnits[0].bidders).to.be.an('array');
      });

      it('should mark auction as sent after sending analytics', function () {
        // Test that calling sendAuctionAnalytics marks it as sent
        // and the sent flag prevents duplicate sends
        events.emit(EVENTS.AUCTION_INIT, mockAuctionInit);
        events.emit(EVENTS.BID_REQUESTED, mockBidRequested);
        events.emit(EVENTS.BID_RESPONSE, mockBidResponse);
        events.emit(EVENTS.AUCTION_END, mockAuctionEnd);
        clock.tick(1000);

        // Should have sent at least one request
        const auctionRequests = server.requests.filter(r =>
          r.url === 'https://krk.kargo.com/api/v2/analytics/auction'
        );
        expect(auctionRequests.length).to.equal(1);
      });
    });

    describe('BID_WON', function () {
      it('should mark winning bids and send win event', function () {
        events.emit(EVENTS.AUCTION_INIT, mockAuctionInit);
        events.emit(EVENTS.BID_REQUESTED, mockBidRequested);
        events.emit(EVENTS.BID_RESPONSE, mockBidResponse);
        events.emit(EVENTS.BID_WON, mockBidWon);

        // Win event should be sent immediately
        const winRequest = server.requests.find(r =>
          r.url === 'https://krk.kargo.com/api/v2/analytics/win'
        );
        expect(winRequest).to.exist;

        const payload = JSON.parse(winRequest.requestBody);
        expect(payload.auctionId).to.equal(mockAuctionId);
        expect(payload.adUnitCode).to.equal(mockAdUnitCode);
        expect(payload.winner.bidder).to.equal('kargo');
      });

      it('should include kargo participation data in win event', function () {
        events.emit(EVENTS.AUCTION_INIT, mockAuctionInit);
        events.emit(EVENTS.BID_REQUESTED, mockBidRequested);
        events.emit(EVENTS.BID_RESPONSE, mockBidResponse);
        events.emit(EVENTS.BID_WON, mockBidWon);

        const winRequest = server.requests.find(r =>
          r.url === 'https://krk.kargo.com/api/v2/analytics/win'
        );
        expect(winRequest).to.exist;

        const payload = JSON.parse(winRequest.requestBody);
        expect(payload.kargo).to.exist;
        expect(payload.kargo.participated).to.be.true;
      });
    });
  });

  describe('privacy consent', function () {
    beforeEach(function () {
      kargoAnalyticsAdapter.enableAnalytics(defaultAdapterConfig);
    });

    it('should extract GDPR consent', function () {
      events.emit(EVENTS.AUCTION_INIT, mockAuctionInit);
      events.emit(EVENTS.AUCTION_END, mockAuctionEnd);
      clock.tick(1000);

      expect(server.requests.length).to.be.at.least(1);
      const payload = JSON.parse(server.requests[0].requestBody);
      expect(payload.consent).to.exist;
      expect(payload.consent.gdpr).to.exist;
      expect(payload.consent.gdpr.applies).to.be.true;
      expect(payload.consent.gdpr.consentString).to.equal('[present]');
    });

    it('should extract USP consent', function () {
      events.emit(EVENTS.AUCTION_INIT, mockAuctionInit);
      events.emit(EVENTS.AUCTION_END, mockAuctionEnd);
      clock.tick(1000);

      expect(server.requests.length).to.be.at.least(1);
      const payload = JSON.parse(server.requests[0].requestBody);
      expect(payload.consent.usp).to.equal('1YNN');
    });

    it('should not include raw consent strings', function () {
      events.emit(EVENTS.AUCTION_INIT, mockAuctionInit);
      events.emit(EVENTS.AUCTION_END, mockAuctionEnd);
      clock.tick(1000);

      expect(server.requests.length).to.be.at.least(1);
      const payload = JSON.parse(server.requests[0].requestBody);
      // Should not contain actual consent string
      expect(payload.consent.gdpr.consentString).to.not.equal('mock-consent-string');
    });
  });

  describe('sampling', function () {
    it('should send all events at 100% sampling', function () {
      kargoAnalyticsAdapter.enableAnalytics({
        provider: 'kargo',
        options: { sampling: 100, sendDelay: 0 }
      });

      events.emit(EVENTS.AUCTION_INIT, mockAuctionInit);
      events.emit(EVENTS.AUCTION_END, mockAuctionEnd);
      clock.tick(1000);

      expect(server.requests.length).to.be.at.least(1);
    });

    it('should respect 0% sampling rate', function () {
      kargoAnalyticsAdapter.enableAnalytics({
        provider: 'kargo',
        options: { sampling: 0, sendDelay: 0 }
      });

      events.emit(EVENTS.AUCTION_INIT, { ...mockAuctionInit, auctionId: 'new-auction-1' });
      events.emit(EVENTS.AUCTION_END, { auctionId: 'new-auction-1' });
      clock.tick(1000);

      expect(server.requests.length).to.equal(0);
    });
  });

  describe('payload formatting', function () {
    beforeEach(function () {
      kargoAnalyticsAdapter.enableAnalytics(defaultAdapterConfig);
    });

    it('should format auction payload correctly', function () {
      events.emit(EVENTS.AUCTION_INIT, mockAuctionInit);
      events.emit(EVENTS.BID_REQUESTED, mockBidRequested);
      events.emit(EVENTS.BID_RESPONSE, mockBidResponse);
      events.emit(EVENTS.AUCTION_END, mockAuctionEnd);
      clock.tick(1000);

      expect(server.requests.length).to.be.at.least(1);
      const payload = JSON.parse(server.requests[0].requestBody);

      // Check required fields
      expect(payload.version).to.equal('2.0');
      expect(payload.timestamp).to.be.a('number');
      expect(payload.auctionId).to.equal(mockAuctionId);
      expect(payload.auctionTimeout).to.equal(1000);
      expect(payload.pageUrl).to.be.a('string');
    });

    it('should include all bidders in ad unit breakdown', function () {
      // Add a second bidder
      events.emit(EVENTS.AUCTION_INIT, mockAuctionInit);
      events.emit(EVENTS.BID_REQUESTED, mockBidRequested);
      events.emit(EVENTS.BID_REQUESTED, {
        auctionId: mockAuctionId,
        bidderCode: 'appnexus',
        bids: [{
          bidId: 'bid-456',
          adUnitCode: mockAdUnitCode
        }]
      });
      events.emit(EVENTS.BID_RESPONSE, mockBidResponse);
      events.emit(EVENTS.BID_RESPONSE, {
        ...mockBidResponse,
        bidder: 'appnexus',
        bidderCode: 'appnexus',
        requestId: 'bid-456',
        cpm: 3.00
      });
      events.emit(EVENTS.AUCTION_END, mockAuctionEnd);
      clock.tick(1000);

      expect(server.requests.length).to.be.at.least(1);
      const payload = JSON.parse(server.requests[0].requestBody);
      const adUnit = payload.adUnits[0];

      expect(adUnit.bidders.length).to.equal(2);
      expect(adUnit.bidders.map(b => b.bidder)).to.include.members(['kargo', 'appnexus']);
    });

    it('should handle missing or malformed data gracefully', function () {
      events.emit(EVENTS.AUCTION_INIT, {
        auctionId: 'graceful-test-auction',
        timeout: 1000,
        adUnits: [], // Empty ad units
        bidderRequests: [] // Empty bidder requests
      });
      events.emit(EVENTS.AUCTION_END, { auctionId: 'graceful-test-auction' });
      clock.tick(1000);

      expect(server.requests.length).to.be.at.least(1);
      const payload = JSON.parse(server.requests[0].requestBody);
      expect(payload.auctionId).to.equal('graceful-test-auction');
    });
  });

  describe('error handling', function () {
    beforeEach(function () {
      kargoAnalyticsAdapter.enableAnalytics(defaultAdapterConfig);
    });

    it('should handle events without auctionId gracefully', function () {
      // This should not throw
      expect(() => {
        events.emit(EVENTS.BID_RESPONSE, {
          ...mockBidResponse,
          auctionId: undefined
        });
      }).to.not.throw();
    });

    it('should capture bidder errors in payload', function () {
      events.emit(EVENTS.AUCTION_INIT, mockAuctionInit);
      events.emit(EVENTS.BIDDER_ERROR, {
        auctionId: mockAuctionId,
        bidderCode: 'badBidder',
        error: {
          message: 'Network error',
          status: 0
        }
      });
      events.emit(EVENTS.AUCTION_END, mockAuctionEnd);
      clock.tick(1000);

      expect(server.requests.length).to.be.at.least(1);
      const payload = JSON.parse(server.requests[0].requestBody);
      expect(payload.errors).to.be.an('array');
      expect(payload.errors.length).to.equal(1);
      expect(payload.errors[0].bidder).to.equal('badBidder');
      expect(payload.errors[0].error.message).to.equal('Network error');
    });
  });

  describe('competitive metrics', function () {
    beforeEach(function () {
      kargoAnalyticsAdapter.enableAnalytics(defaultAdapterConfig);
    });

    it('should track response times for Kargo bids', function () {
      events.emit(EVENTS.AUCTION_INIT, mockAuctionInit);
      events.emit(EVENTS.BID_REQUESTED, mockBidRequested);
      events.emit(EVENTS.BID_RESPONSE, mockBidResponse);
      events.emit(EVENTS.AUCTION_END, mockAuctionEnd);
      clock.tick(1000);

      const payload = JSON.parse(server.requests[0].requestBody);
      expect(payload.kargo.bids[0].responseTime).to.equal(192);
    });

    it('should track CPM in USD', function () {
      events.emit(EVENTS.AUCTION_INIT, mockAuctionInit);
      events.emit(EVENTS.BID_REQUESTED, mockBidRequested);
      events.emit(EVENTS.BID_RESPONSE, mockBidResponse);
      events.emit(EVENTS.AUCTION_END, mockAuctionEnd);
      clock.tick(1000);

      const payload = JSON.parse(server.requests[0].requestBody);
      expect(payload.kargo.bids[0].cpm).to.equal(2.5);
    });

    it('should calculate average response time', function () {
      events.emit(EVENTS.AUCTION_INIT, mockAuctionInit);
      events.emit(EVENTS.BID_REQUESTED, mockBidRequested);
      events.emit(EVENTS.BID_RESPONSE, mockBidResponse);
      events.emit(EVENTS.AUCTION_END, mockAuctionEnd);
      clock.tick(1000);

      const payload = JSON.parse(server.requests[0].requestBody);
      expect(payload.kargo.avgResponseTime).to.equal(192);
    });
  });
});
