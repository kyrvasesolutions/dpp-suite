/**
 * Synthetic product data for an extruded aluminium profile, laid out the way a
 * manufacturer's own system might, so its field names don't match the data
 * requirements and have to be mapped. All values are invented.
 */
export const SAMPLE_FILENAME = "aluminium-profile-sample.json";

export const SAMPLE_DATA = {
  article: {
    sku: "AP-6063-T5-40x40-6000",
    gtin: "05412345678901",
    serialBatch: "LOT-2026-04-118",
    description: "Extruded aluminium square profile 40x40x2.0 mm, alloy EN AW-6063 T5, mill finish",
    customsTariffNumber: "7604 21 00",
    productionDate: "2026-04-22",
  },
  producer: {
    legalName: "Nordal Extrusions GmbH",
    address: "Industriestrasse 12, 41460 Neuss, Germany",
    contactEmail: "compliance@nordal-extrusions.example",
    euRepresentative: "Nordal Extrusions GmbH (established in the EU)",
    wasteRegisterNo: "DE 98765432",
  },
  alloy: {
    designation: "EN AW-6063",
    temper: "T5",
    composition: [
      { element: "Al", massPercent: 98.9 },
      { element: "Mg", massPercent: 0.55 },
      { element: "Si", massPercent: 0.4 },
      { element: "Fe", massPercent: 0.15 },
    ],
    recycledShare: { postConsumerPercent: 42, preConsumerPercent: 18 },
  },
  chemicals: {
    svhcAboveThreshold: false,
    svhcList: [],
    reachCompliant: true,
    surfaceTreatmentSubstances: "none (mill finish)",
  },
  climate: {
    cradleToGateCo2ePerKg: 6.8,
    co2eMethod: "EN 15804+A2, GWP-total",
    smeltingRoute: "Primary electrolysis, 70% hydropower, remelt for billet casting",
    directEmissionsTco2ePerT: 1.9,
    indirectEmissionsTco2ePerT: 4.1,
    electricityMwhPerT: 14.2,
    precursor: {
      name: "Aluminium billet 6063, 178 mm",
      embeddedTco2ePerT: 6.1,
      originCountry: "NO",
    },
    carbonPricePaidEurPerT: 0,
  },
  origin: {
    smelterCountry: "NO",
    smelter: "Fjordmetall AS, Husnes",
    extrusionPlant: "Neuss, DE",
    bauxiteSourcing: "Guinea, mine audited under ASI Performance Standard",
    dueDiligenceReport: "https://nordal-extrusions.example/due-diligence-2025.pdf",
  },
  endOfLife: {
    recyclable: true,
    recyclabilityRate: 0.95,
    sortingCode: "ALU 41",
    dismantlingInstruction: "Separate from steel fasteners; collect as clean aluminium scrap.",
  },
  performance: {
    tensileStrengthMpa: 160,
    yieldStrengthMpa: 110,
    elongationPercent: 8,
    declarationOfPerformance: "DoP-2026-AP-0418",
    notifiedBodyCertificate: "1234-CPR-0567",
  },
  labelling: {
    marking: "CE, EN 15088",
    qrCarrierUrl: "https://id.nordal-extrusions.example/01/05412345678901/10/LOT-2026-04-118",
    safetyDataSheet: "https://nordal-extrusions.example/sds/6063.pdf",
  },
};

export const sampleFile = () =>
  new File([JSON.stringify(SAMPLE_DATA, null, 2)], SAMPLE_FILENAME, { type: "application/json" });
