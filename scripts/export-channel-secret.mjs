// Export only the selected channel secret; never print it or overwrite a destination.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function exportChannelSecret({ home, channel, output }) {
  if (!home || !channel || !output) throw new Error("Missing argument");
  const config = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
  const secret = config.channels?.[channel]?.secret;
  if (typeof secret !== "string" || secret.length < 16) throw new Error("Missing channel secret");
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  fs.writeFileSync(output, secret + "\n", { flag: "wx", mode: 0o600 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [channel, output] = process.argv.slice(2);
    exportChannelSecret({ home: process.env.CCIM_HOME || path.join(os.homedir(), ".ccim"), channel, output });
    console.log("Channel secret saved to a new private file (0600); no value printed.");
  } catch {
    console.error("Export failed. Check channel, private config and destination; existing files are never overwritten. No credential details printed.");
    process.exitCode = 1;
  }
}
