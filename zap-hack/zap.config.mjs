export default {
  environment: "stage", // only stage is supported right now
  widgets: "../widgets",

  // Overlay on the platform env template. TENANT becomes the `tenant` claim in the
  // M2M token the platform mints and forwards to tool servers (default would be "demo").
  env: {
    TENANT: "westship",
  },

  sources: {
    localDomains: [
      { path: "./zap", openApiUrl: "http://localhost:9001/openapi.json" },
    ],
  },
};
