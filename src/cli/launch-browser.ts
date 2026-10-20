// Opens the MCP browser profile for manual login. Stays alive until the window is closed
// (the MCP server must not be running at the same time: one process per profile).
// Always visible: headless is the server default, but there is no window to log into headless.
// Set before config loads (static imports are hoisted, so these two are dynamic).
process.env.LINKEDIN_HEADLESS = "0";
const { config } = await import("../config.js");
const { getContext } = await import("../browser/session.js");

const ctx = await getContext();
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto("https://www.linkedin.com/feed/");
console.error(`MCP ${config.browserName} open. Log into LinkedIn, then close the window.`);
await new Promise<void>((r) => ctx.on("close", () => r()));
