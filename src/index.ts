import os from "os";
import { execSync } from "child_process";
import chalk from "chalk";
import { highlight } from "cli-highlight";
import { sendMessage } from "./chatgpt";

const platform = (() => {
  switch (os.platform()) {
    case "darwin":
      return "macOS";
    case "win32":
      return "Windows";
    case "linux":
      return "Linux";
    default:
      return os.platform();
  }
})();

const args = process.argv.slice(2).join(" ");

async function main() {
  const res = await sendMessage(
    `How ${args}? I'm on ${platform} cli. Reply in a Markdown code block and don't add any comment or explanation. ` +
      `Your entire answer must be machine executable and start with \`\`\`. Do not add "related" commands.`
  );

  const answer = res.text
    .trim()
    .replace(/^```(sh|bash)?/gm, "")
    .replace(/```$/gm, "")
    .trim();

  async function keypress() {
    process.stdin.setRawMode(true);
    return new Promise<string>((resolve) =>
      process.stdin.once("data", (data) => {
        const byteArray = [...data];
        if (byteArray.length > 0 && byteArray[0] === 3) {
          console.log("^C");
          process.exit(1);
        }
        process.stdin.setRawMode(false);
        resolve(data.toString("utf-8"));
      })
    );
  }

  process.stdout.write(
    chalk.gray("$ ") +
      highlight(answer, { language: "bash" }) +
      chalk.gray(" (y/n) ")
  );

  if ((await keypress()) === "y") {
    process.stdout.write(os.EOL);
    execSync(answer, { stdio: "inherit" });
  }

  process.exit(0);
}

main();
