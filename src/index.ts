import os from "os";
import { execSync } from "child_process";
import chalk from "chalk";
import { highlight } from "cli-highlight";

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

async function sendMessage(prompt: string) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      messages: [
        {
          role: "system",
          content: `You are a coding assistant and trained large language model. Respond with code that is as concisely as possible and do not add comments. Today is ${new Date().toLocaleString()}}.`,
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      temperature: 0.8,
      max_tokens: 512,
      top_p: 1,
      frequency_penalty: 0,
      presence_penalty: 0,
      model: "gpt-3.5-turbo",
      stream: false,
    }),
  });

  const json = (await res.json()) as {
    id: `chatcmpl-${string}`;
    object: "chat.completion";
    created: number; // seconds since epoch
    model: "gpt-3.5-turbo-0301";
    usage: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    };
    choices: {
      message: {
        role: "assistant";
        content: string;
      };
      finish_reason: "stop";
      index: number;
    }[];
  };

  return json.choices[0].message.content;
}

async function main() {
  const res = await sendMessage(
    `How ${args}? I'm on ${platform} cli. Reply in a Markdown code block and don't add any comment or explanation. ` +
      `Your entire answer must be machine executable and start with \`\`\`. Do not add "related" commands.`
  );

  const answer = res
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
