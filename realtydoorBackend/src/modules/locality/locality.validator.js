const { z } = require('zod');

const priceTrendsSchema = z.object({
  historical: z.array(z.object({ period: z.string(), price: z.number() })),
  growth: z.object({
    oneYear: z.number().optional(),
    threeYear: z.number().optional(),
    fiveYear: z.number().optional(),
  }).optional(),
});

const propertyMixSchema = z.array(z.object({
  type: z.string(),
  percentage: z.number().min(0).max(100),
  count: z.number().int().nonnegative().optional(),
}));

const microMarketsSchema = z.array(z.object({
  name: z.string(),
  avgPricePerSqft: z.number().positive(),
  rentalDemand: z.string().optional(),
}));

const keyInfrastructureSchema = z.array(z.object({
  name: z.string(),
  category: z.string(),
  distance: z.string().optional(),
  line: z.string().optional(),
  status: z.string().optional(),
  code: z.string().optional(),
  description: z.string().optional(),
}));

const connectivitySchema = z.object({
  metro: z.array(z.object({ name: z.string(), line: z.string().optional(), status: z.string().optional() })).optional(),
  airports: z.array(z.object({ name: z.string(), code: z.string().optional(), distance: z.string().optional() })).optional(),
  majorRoads: z.array(z.string()).optional(),
  travelTimes: z.array(z.object({ destination: z.string(), time: z.string() })).optional(),
});

const infrastructureProjectsSchema = z.array(z.object({
  name: z.string(),
  category: z.string().optional(),
  status: z.string(),
  year: z.number().int().optional(),
  impact: z.string().optional(),
}));

const prosAndConsSchema = z.object({
  pros: z.array(z.string()),
  cons: z.array(z.string()),
});

const investmentScoreSchema = z.object({
  overall: z.number().min(0).max(10),
  factors: z.object({
    priceGrowth: z.number().optional(),
    rentalDemand: z.number().optional(),
    connectivity: z.number().optional(),
    infrastructure: z.number().optional(),
    liquidity: z.number().optional(),
    risk: z.number().optional(),
  }).optional(),
});

const buyVsRentSchema = z.object({
  buyerDemandPct: z.number().min(0).max(100).optional(),
  sellerDemandPct: z.number().min(0).max(100).optional(),
  avgRentByBhk: z.record(z.string(), z.number()).optional(),
  rentalYieldPct: z.number().optional(),
  rentTrend1yPct: z.number().optional(),
});

const faqsSchema = z.array(z.object({ question: z.string(), answer: z.string() }));

const upsertLocalitySchema = z.object({
  city:     z.string().min(2).max(100),
  locality: z.string().min(2).max(100),
  citySlug:     z.string().optional(),
  localitySlug: z.string().optional(),

  // Core price panel (property-detail page) — matches LocalityInsight scalar fields
  avgPricePerSqftPaise:    z.number().int().positive(),
  minPricePerSqftPaise:    z.number().int().positive().optional(),
  maxPricePerSqftPaise:    z.number().int().positive().optional(),
  avgRentPerMonthPaise:    z.number().int().positive().optional(),
  priceChangeLastMonthPct: z.number().optional(),
  nearbyInfra:             z.array(z.string()).optional(),
  dataAsOfDate:            z.string().datetime().optional(), // defaults to now() if omitted

  // Locality market-intelligence page (admin-curated)
  subtitle:                z.string().max(200).optional(),
  localityScore:           z.number().min(0).max(10).optional(),
  marketStage:             z.string().max(100).optional(),
  rentalDemand:            z.string().max(100).optional(),
  infrastructureStrength:  z.string().max(100).optional(),
  bestFor:                 z.array(z.string()).optional(),
  medianPricePaise:        z.number().int().positive().optional(),
  medianPricePropertyType: z.string().max(50).optional(),
  avgRentYieldPct:         z.number().optional(),
  priceTrends:             priceTrendsSchema.optional(),
  propertyMix:             propertyMixSchema.optional(),
  microMarkets:            microMarketsSchema.optional(),
  keyInfrastructure:       keyInfrastructureSchema.optional(),
  connectivity:            connectivitySchema.optional(),
  infrastructureProjects:  infrastructureProjectsSchema.optional(),
  prosAndCons:             prosAndConsSchema.optional(),
  investmentScore:         investmentScoreSchema.optional(),
  buyVsRent:               buyVsRentSchema.optional(),
  faqs:                    faqsSchema.optional(),
});

module.exports = { upsertLocalitySchema };
