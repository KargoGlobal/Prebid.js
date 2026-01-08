# Kargo Analytics Adapter - Endpoint Schema Documentation

**Version:** 2.0  
**Last Updated:** January 8, 2026  
**Contact:** [Your Name / Team]

---

## Overview

The Kargo Analytics Adapter sends auction and win event data from Prebid.js to Kargo's analytics endpoints. This document describes the payload schemas for each endpoint to help the data team understand the data structure and build the receiving infrastructure.

---

## Endpoints

| Endpoint | Method | Content-Type | Purpose |
|----------|--------|--------------|---------|
| `/api/v2/analytics/auction` | POST | application/json | Comprehensive auction data sent after each auction completes |
| `/api/v2/analytics/win` | POST | application/json | Individual win events sent when a bid wins the auction |

**Base URL:** `https://krk.kargo.com`

---

## 1. Auction Endpoint

**URL:** `POST /api/v2/analytics/auction`

This endpoint receives comprehensive auction data after each Prebid auction completes. Data is sent after a short delay (default 500ms) to capture any late `BID_WON` events.

### Payload Schema

```typescript
interface AuctionPayload {
  // === METADATA ===
  version: string;              // Schema version, currently "2.0"
  timestamp: number;            // Unix timestamp in milliseconds when payload was created
  prebidVersion: string;        // Prebid.js version (e.g., "10.21.0")

  // === AUCTION IDENTIFIERS ===
  auctionId: string;            // UUID for this specific auction

  // === TIMING ===
  auctionTimeout: number;       // Configured auction timeout in milliseconds
  auctionDuration: number;      // Actual auction duration in milliseconds

  // === PAGE CONTEXT ===
  pageUrl: string | null;       // Top-level page URL where auction occurred

  // === PRIVACY CONSENT ===
  consent: ConsentData | null;

  // === KARGO-SPECIFIC METRICS ===
  kargo: KargoMetrics;

  // === AUCTION SUMMARY (all bidders) ===
  auction: AuctionSummary;

  // === PER-AD-UNIT BREAKDOWN ===
  adUnits: AdUnitSummary[];

  // === ERRORS ===
  errors: BidderError[];
}
```

### Nested Types

#### ConsentData
```typescript
interface ConsentData {
  gdpr?: {
    applies: boolean;           // Whether GDPR applies to this user
    consentString: string;      // "[present]" if consent string exists, null otherwise
                                // NOTE: Raw consent string is NOT sent for privacy
  };
  usp?: string;                 // US Privacy string (e.g., "1YNN")
  gpp?: {
    gppString: string;          // "[present]" if GPP string exists, null otherwise
    applicableSections: number[]; // GPP applicable section IDs
  };
  coppa?: boolean;              // COPPA flag if present
}
```

#### KargoMetrics
```typescript
interface KargoMetrics {
  bidCount: number;             // Total Kargo bids in this auction
  winCount: number;             // Number of Kargo wins
  avgResponseTime: number | null; // Average response time for Kargo bids (ms)
  avgCpm: number | null;        // Average CPM for Kargo bids (USD)
  bids: KargoBidDetail[];       // Detailed per-bid breakdown
}

interface KargoBidDetail {
  adUnitCode: string;           // Ad unit code where bid was placed
  status: BidStatus;            // "received" | "no-bid" | "timeout" | "error" | "pending"
  cpm: number | null;           // Kargo's bid CPM in USD
  responseTime: number | null;  // Time to respond in milliseconds
  won: boolean;                 // Whether Kargo won this ad unit
  
  // Competitive Intelligence
  winningBidder: string | null; // Which bidder won (if not Kargo)
  winningCpm: number | null;    // Winning CPM in USD
  marginToWin: number | null;   // Difference: winningCpm - kargoCpm
                                // Positive = how much more Kargo needed
                                // Negative = how much Kargo won by
  rank: number | null;          // Kargo's position (1 = highest CPM, 2 = second, etc.)
}
```

#### AuctionSummary
```typescript
interface AuctionSummary {
  bidderCount: number;          // Number of bidders in auction
  totalBidsRequested: number;   // Total bid requests across all ad units
  totalBidsReceived: number;    // Total successful bid responses
  totalNoBids: number;          // Total no-bid responses
  totalTimeouts: number;        // Total timed-out bids
  totalErrors: number;          // Total bidder errors
}
```

#### AdUnitSummary
```typescript
interface AdUnitSummary {
  code: string;                 // Ad unit code (e.g., "div-gpt-ad-123")
  mediaTypes: string[];         // Media types (e.g., ["banner"], ["video"], ["banner", "video"])
  bidders: BidderResult[];      // All bidder results for this ad unit
  winningBidder: string | null; // Bidder that won this ad unit
  winningCpm: number | null;    // Winning CPM in USD
}

interface BidderResult {
  bidder: string;               // Bidder code (e.g., "kargo", "appnexus", "rubicon")
  status: BidStatus;            // "received" | "no-bid" | "timeout" | "error" | "pending"
  cpm: number | null;           // Bid CPM in USD (null if no bid)
  responseTime: number | null;  // Response time in milliseconds
  isKargo: boolean;             // Whether this is a Kargo bid
  won: boolean;                 // Whether this bid won
}

type BidStatus = "received" | "no-bid" | "timeout" | "error" | "pending";
```

#### BidderError
```typescript
interface BidderError {
  bidder: string;               // Bidder code that errored
  error: {
    message: string;            // Error message
    status?: number;            // HTTP status code if applicable
  };
  timestamp: number;            // When the error occurred (Unix ms)
}
```

### Example Payload

```json
{
  "version": "2.0",
  "timestamp": 1736361600000,
  "prebidVersion": "10.21.0",
  "auctionId": "66529d4c-8998-47c2-ab3e-5b953490b98f",
  "auctionTimeout": 1000,
  "auctionDuration": 487,
  "pageUrl": "https://example.com/article/12345",
  "consent": {
    "gdpr": {
      "applies": true,
      "consentString": "[present]"
    },
    "usp": "1YNN"
  },
  "kargo": {
    "bidCount": 2,
    "winCount": 1,
    "avgResponseTime": 156.5,
    "avgCpm": 2.75,
    "bids": [
      {
        "adUnitCode": "div-gpt-ad-header",
        "status": "received",
        "cpm": 3.50,
        "responseTime": 142,
        "won": true,
        "winningBidder": "kargo",
        "winningCpm": 3.50,
        "marginToWin": 0,
        "rank": 1
      },
      {
        "adUnitCode": "div-gpt-ad-sidebar",
        "status": "received",
        "cpm": 2.00,
        "responseTime": 171,
        "won": false,
        "winningBidder": "rubicon",
        "winningCpm": 2.85,
        "marginToWin": 0.85,
        "rank": 2
      }
    ]
  },
  "auction": {
    "bidderCount": 4,
    "totalBidsRequested": 8,
    "totalBidsReceived": 6,
    "totalNoBids": 1,
    "totalTimeouts": 1,
    "totalErrors": 0
  },
  "adUnits": [
    {
      "code": "div-gpt-ad-header",
      "mediaTypes": ["banner"],
      "bidders": [
        {
          "bidder": "kargo",
          "status": "received",
          "cpm": 3.50,
          "responseTime": 142,
          "isKargo": true,
          "won": true
        },
        {
          "bidder": "appnexus",
          "status": "received",
          "cpm": 2.10,
          "responseTime": 198,
          "isKargo": false,
          "won": false
        },
        {
          "bidder": "rubicon",
          "status": "no-bid",
          "cpm": null,
          "responseTime": null,
          "isKargo": false,
          "won": false
        },
        {
          "bidder": "openx",
          "status": "timeout",
          "cpm": null,
          "responseTime": null,
          "isKargo": false,
          "won": false
        }
      ],
      "winningBidder": "kargo",
      "winningCpm": 3.50
    },
    {
      "code": "div-gpt-ad-sidebar",
      "mediaTypes": ["banner", "video"],
      "bidders": [
        {
          "bidder": "kargo",
          "status": "received",
          "cpm": 2.00,
          "responseTime": 171,
          "isKargo": true,
          "won": false
        },
        {
          "bidder": "rubicon",
          "status": "received",
          "cpm": 2.85,
          "responseTime": 156,
          "isKargo": false,
          "won": true
        }
      ],
      "winningBidder": "rubicon",
      "winningCpm": 2.85
    }
  ],
  "errors": []
}
```

---

## 2. Win Endpoint

**URL:** `POST /api/v2/analytics/win`

This endpoint receives individual win events in real-time when a bid wins an auction (the `BID_WON` Prebid event). This is useful for tracking actual impressions vs. just auction wins.

### Payload Schema

```typescript
interface WinPayload {
  version: string;              // Schema version, currently "2.0"
  timestamp: number;            // Unix timestamp in milliseconds
  auctionId: string;            // Auction UUID this win belongs to
  adUnitCode: string;           // Ad unit code that was won

  winner: {
    bidder: string;             // Winning bidder code
    cpm: number;                // Winning CPM in original currency
    cpmUsd: number;             // Winning CPM converted to USD
  };

  kargo: KargoWinData | null;   // Kargo's participation data (null if Kargo didn't bid)
}

interface KargoWinData {
  participated: boolean;        // Whether Kargo bid on this ad unit
  cpm: number | null;           // Kargo's CPM in USD (null if didn't participate)
  margin: number | null;        // winningCpm - kargoCpm (how much Kargo lost/won by)
  rank: number | null;          // Kargo's rank in the auction (1 = highest, etc.)
}
```

### Example Payload

```json
{
  "version": "2.0",
  "timestamp": 1736361600500,
  "auctionId": "66529d4c-8998-47c2-ab3e-5b953490b98f",
  "adUnitCode": "div-gpt-ad-header",
  "winner": {
    "bidder": "kargo",
    "cpm": 3.50,
    "cpmUsd": 3.50
  },
  "kargo": {
    "participated": true,
    "cpm": 3.50,
    "margin": 0,
    "rank": 1
  }
}
```

### Example: Kargo Lost

```json
{
  "version": "2.0",
  "timestamp": 1736361600500,
  "auctionId": "66529d4c-8998-47c2-ab3e-5b953490b98f",
  "adUnitCode": "div-gpt-ad-sidebar",
  "winner": {
    "bidder": "rubicon",
    "cpm": 2.85,
    "cpmUsd": 2.85
  },
  "kargo": {
    "participated": true,
    "cpm": 2.00,
    "margin": 0.85,
    "rank": 2
  }
}
```

### Example: Kargo Didn't Participate

```json
{
  "version": "2.0",
  "timestamp": 1736361600500,
  "auctionId": "66529d4c-8998-47c2-ab3e-5b953490b98f",
  "adUnitCode": "div-gpt-ad-footer",
  "winner": {
    "bidder": "appnexus",
    "cpm": 1.50,
    "cpmUsd": 1.50
  },
  "kargo": {
    "participated": false,
    "cpm": null,
    "margin": null,
    "rank": null
  }
}
```

---

## Configuration Options

Publishers can configure the analytics adapter with these options:

```javascript
pbjs.enableAnalytics({
  provider: 'kargo',
  options: {
    sampling: 100,        // Percentage of auctions to track (1-100), default: 100
    sendWinEvents: true,  // Whether to send individual /win events, default: true
    sendDelay: 500        // Delay in ms before sending auction data, default: 500
  }
});
```

---

## Data Considerations

### Sampling
- When `sampling < 100`, data is randomly sampled at the session level
- This means either ALL auctions from a session are tracked, or NONE
- Useful for high-traffic publishers to reduce data volume

### Currency
- All CPM values are converted to USD using Prebid's currency conversion
- If conversion fails, the original CPM value is used
- `currency` field in raw bid data is preserved for reference

### Privacy
- GDPR/GPP consent strings are NOT sent in full
- Only `"[present]"` marker is sent to indicate consent was provided
- USP string is sent in full (it's short and standardized)
- No PII is collected

### Timing
- `auctionDuration` = time from AUCTION_INIT to AUCTION_END
- `responseTime` = time from bid request to bid response (per bidder)
- All timestamps are Unix milliseconds

### Error States
- `status: "pending"` - Bid was requested but no response received yet
- `status: "no-bid"` - Bidder explicitly returned no bid
- `status: "timeout"` - Bidder didn't respond within auction timeout
- `status: "error"` - Bidder returned an error
- `status: "received"` - Valid bid received

---

## Expected Data Volume

| Metric | Estimate |
|--------|----------|
| Auction events | 1 per page view per ad unit refresh |
| Win events | 0-N per auction (one per ad unit that renders) |
| Payload size (auction) | 2-10 KB depending on bidder count |
| Payload size (win) | ~500 bytes |

---

## Recommended Database Schema

### Auction Events Table

```sql
CREATE TABLE kargo_auction_events (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  auction_id VARCHAR(36) NOT NULL,
  received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  -- Metadata
  version VARCHAR(10),
  event_timestamp BIGINT,
  prebid_version VARCHAR(20),
  
  -- Timing
  auction_timeout INT,
  auction_duration INT,
  
  -- Context
  page_url TEXT,
  
  -- Consent (store as JSON or separate columns)
  consent_gdpr_applies BOOLEAN,
  consent_usp VARCHAR(10),
  
  -- Summary
  bidder_count INT,
  total_bids_requested INT,
  total_bids_received INT,
  total_no_bids INT,
  total_timeouts INT,
  total_errors INT,
  
  -- Kargo Summary
  kargo_bid_count INT,
  kargo_win_count INT,
  kargo_avg_response_time DECIMAL(10,2),
  kargo_avg_cpm DECIMAL(10,3),
  
  -- Store full payload for detailed analysis
  raw_payload JSON,
  
  INDEX idx_auction_id (auction_id),
  INDEX idx_timestamp (event_timestamp)
);
```

### Kargo Bids Table (Denormalized)

```sql
CREATE TABLE kargo_bid_details (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  auction_id VARCHAR(36) NOT NULL,
  ad_unit_code VARCHAR(255),
  
  status VARCHAR(20),
  cpm DECIMAL(10,3),
  response_time INT,
  won BOOLEAN,
  
  winning_bidder VARCHAR(50),
  winning_cpm DECIMAL(10,3),
  margin_to_win DECIMAL(10,3),
  rank INT,
  
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  INDEX idx_auction_id (auction_id),
  INDEX idx_won (won),
  INDEX idx_status (status)
);
```

---

## Questions for Data Team

1. **Retention:** How long should auction data be retained?
2. **Aggregation:** Should we pre-aggregate data for dashboards?
3. **Alerting:** What metrics should trigger alerts?
4. **Backfill:** Do we need to support backfilling historical data?
5. **Rate Limiting:** What's the expected QPS we need to handle?

---

## Change Log

| Version | Date | Changes |
|---------|------|---------|
| 2.0 | Jan 2026 | Complete rewrite with full event tracking, competitive intelligence |
| 1.0 | Jul 2022 | Original minimal implementation (4 fields, Kargo only) |

---

*Document Author: [Your Name]*  
*For questions, contact: [team email/slack]*
