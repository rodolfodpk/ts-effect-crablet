// Regenerates docs/api/wallet-openapi.json. Run it (`bun run docs:api`) after changing a wallet command,
// its input, its declared errors or a read endpoint; the unit test fails until the checked-in file matches.
import { writeFileSync } from "node:fs";
import { walletOpenApiDocument, walletOpenApiFile } from "../src/api/WalletOpenApi.ts";

writeFileSync(walletOpenApiFile, walletOpenApiDocument());
console.log(`wrote ${walletOpenApiFile.pathname}`);
