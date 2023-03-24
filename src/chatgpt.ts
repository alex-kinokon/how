// Based on https://github.com/transitive-bullshit/chatgpt-api/tree/48ad624904cf80891a9f461c8a3a93344b3c6e2f
// MIT License. Copyright (c) 2023 Travis Fischer.
import KeyValue from "keyv";
import { v4 as uuid } from "uuid";
import { get_encoding } from "@dqbd/tiktoken";
import { createParser } from "eventsource-parser";

const [currentDate] = new Date().toISOString().split("T");
const SYSTEM_MESSAGE = `You are ChatGPT, a large language model trained by OpenAI. Answer as concisely as possible.\nKnowledge cutoff: 2021-09-01\nCurrent date: ${currentDate}`;

const BASE_URL = "https://api.openai.com/v1";
const CHATGPT_MODEL = "gpt-3.5-turbo";
const USER_LABEL_DEFAULT = "User";
const ASSISTANT_LABEL_DEFAULT = "ChatGPT";
const apiKey = process.env.OPENAI_API_KEY!;

const maxModelTokens = 4000;
const maxResponseTokens = 1000;
const debug = false;

const defaultCompletionParams: Omit<
  openai.CreateChatCompletionRequest,
  "messages" | "n"
> = {
  model: CHATGPT_MODEL,
  temperature: 0.8,
  top_p: 1.0,
  presence_penalty: 1.0,
};

export const messageStore: KeyValue<ChatMessage> = new KeyValue<
  ChatMessage,
  any
>({
  store: new Map<string, ChatMessage>(),
});

type Role = "user" | "assistant" | "system";

class TimeoutError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

/**
 * Timeout a promise after a specified amount of time.
 * If you pass in a cancelable promise, specifically a promise with a `.cancel()` method, that method will be called when the `pTimeout` promise times out.
 * @param input - Promise to decorate.
 * @returns A decorated `input` that times out after `milliseconds` time. It has a `.clear()` method that clears the timeout.
 * @example
 * ```
 * import {setTimeout} from 'node:timers/promises';
 * import pTimeout from 'p-timeout';
 * const delayedPromise = () => setTimeout(200);
 * await pTimeout(delayedPromise(), {
 * 	milliseconds: 50,
 * 	fallback: () => {
 * 		return pTimeout(delayedPromise(), {milliseconds: 300});
 * 	}
 * });
 * ```
 */
export function pTimeout<ValueType, ReturnType = ValueType>(
  promise: PromiseLike<ValueType> & { cancel?: () => void },
  options: {
    /**
     * Milliseconds before timing out.
     */
    milliseconds: number;

    /**
     * Specify a custom error message or error to throw when it times out:
     *
     * - `message: 'too slow'` will throw `TimeoutError('too slow')`
     * - `message: new MyCustomError('it’s over 9000')` will throw the same error instance
     * - `message: false` will make the promise resolve with `undefined` instead of rejecting
     *
     * If you do a custom error, it's recommended to sub-class `TimeoutError`:
     *
     * ```
     * import {TimeoutError} from 'p-timeout';
     *
     * class MyCustomError extends TimeoutError {
     * 	name = "MyCustomError";
     * }
     * ```
     */
    message?: string | Error | false;
  }
): Promise<ValueType | ReturnType> {
  const { milliseconds, message } = options;

  let timer: NodeJS.Timeout | undefined;

  return new Promise<ValueType | ReturnType>((resolve, reject) => {
    // We create the error outside of `setTimeout` to preserve the stack trace.
    const timeoutError = new TimeoutError();

    timer = setTimeout(() => {
      if (typeof promise.cancel === "function") {
        promise.cancel();
      }

      if (message === false) {
        resolve(undefined!);
      } else if (message instanceof Error) {
        reject(message);
      } else {
        timeoutError.message =
          message ?? `Promise timed out after ${milliseconds} milliseconds`;
        reject(timeoutError);
      }
    }, milliseconds);

    (async () => {
      try {
        resolve(await promise);
      } catch (error) {
        reject(error);
      } finally {
        clearTimeout.call(undefined, timer);
      }
    })();
  });
}

const tokenizer = get_encoding("cl100k_base");

function encode(input: string): Uint32Array {
  return tokenizer.encode(input);
}

async function* streamAsyncIterable<T>(stream: ReadableStream<T>) {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

async function fetchSSE(
  url: string,
  options: Parameters<typeof fetch>[1] & { onMessage: (data: string) => void }
) {
  const { onMessage, ...fetchOptions } = options;
  const res = await fetch(url, fetchOptions);
  if (!res.ok) {
    let reason: string;

    try {
      reason = await res.text();
    } catch (err) {
      reason = res.statusText;
    }

    const msg = `ChatGPT error ${res.status}: ${reason}`;
    const error = new ChatGPTError(msg, { cause: res });
    error.statusCode = res.status;
    error.statusText = res.statusText;
    throw error;
  }

  const parser = createParser((event) => {
    if (event.type === "event") {
      onMessage(event.data);
    }
  });

  if (!res.body?.getReader) {
    // Vercel polyfills `fetch` with `node-fetch`, which doesn't conform to
    // web standards, so this is a workaround...
    const body: NodeJS.ReadableStream = res.body as any;

    if (!body.on || !body.read) {
      throw new ChatGPTError('unsupported "fetch" implementation');
    }

    body.on("readable", () => {
      let chunk: string | Buffer;
      while ((chunk = body.read()) !== null) {
        parser.feed(chunk.toString());
      }
    });
  } else {
    for await (const chunk of streamAsyncIterable(res.body)) {
      const str = new TextDecoder().decode(chunk);
      parser.feed(str);
    }
  }
}

/**
 * Sends a message to the OpenAI chat completions endpoint, waits for the response
 * to resolve, and returns the response.
 *
 * If you want your response to have historical context, you must provide a valid `parentMessageId`.
 *
 * If you want to receive a stream of partial responses, use `opts.onProgress`.
 *
 * Set `debug: true` in the `ChatGPTAPI` constructor to log more info on the full prompt sent to the OpenAI chat completions API. You can override the `systemMessage` in `opts` to customize the assistant's instructions.
 *
 * @param message - The prompt message to send
 * @returns The response from ChatGPT
 */
export async function sendMessage(
  text: string,
  opts: SendMessageOptions = {}
): Promise<ChatMessage> {
  const {
    parentMessageId,
    messageId = uuid(),
    timeoutMs,
    onProgress,
    stream = onProgress ? true : false,
    completionParams,
  } = opts;

  let { abortSignal } = opts;

  let abortController: AbortController | null = null;
  if (timeoutMs && !abortSignal) {
    abortController = new AbortController();
    abortSignal = abortController.signal;
  }

  const message: ChatMessage = {
    role: "user",
    id: messageId,
    parentMessageId,
    text,
  };
  await upsertMessage(message);

  const { messages, maxTokens, numTokens } = await _buildMessages(text, opts);

  const result: ChatMessage = {
    role: "assistant",
    id: uuid(),
    parentMessageId: messageId,
    text: "",
  };

  const response = new Promise<ChatMessage>(async (resolve, reject) => {
    const url = `${BASE_URL}/chat/completions`;
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    };
    const body = {
      max_tokens: maxTokens,
      ...defaultCompletionParams,
      ...completionParams,
      messages,
      stream,
    };

    if (debug) {
      console.log(`sendMessage (${numTokens} tokens)`, body);
    }

    if (stream) {
      fetchSSE(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: abortSignal,
        onMessage(data: string) {
          if (data === "[DONE]") {
            result.text = result.text.trim();
            return resolve(result);
          }

          try {
            const response: openai.CreateChatCompletionDeltaResponse =
              JSON.parse(data);

            if (response.id) {
              result.id = response.id;
            }

            if (response?.choices?.length) {
              const [{ delta }] = response.choices;
              result.delta = delta.content;
              if (delta?.content) result.text += delta.content;
              result.detail = response;

              if (delta.role) {
                result.role = delta.role;
              }

              onProgress?.(result);
            }
          } catch (err) {
            console.warn("OpenAI stream SEE event unexpected error", err);
            return reject(err);
          }
        },
      }).catch(reject);
    } else {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: abortSignal,
        });

        if (!res.ok) {
          const reason = await res.text();
          const msg = `OpenAI error ${res.status || res.statusText}: ${reason}`;
          const error = new ChatGPTError(msg, { cause: res });
          error.statusCode = res.status;
          error.statusText = res.statusText;
          return reject(error);
        }

        const response: openai.CreateChatCompletionResponse = await res.json();
        if (debug) {
          console.log(response);
        }

        if (response?.id) {
          result.id = response.id;
        }

        if (response?.choices?.length) {
          const [{ message }] = response.choices;
          result.text = message!.content;
          if (message?.role) {
            result.role = message.role;
          }
        } else {
          const res = response as any;
          return reject(
            new Error(
              `OpenAI error: ${
                res?.detail?.message || res?.detail || "unknown"
              }`
            )
          );
        }

        result.detail = response;

        return resolve(result);
      } catch (err) {
        return reject(err);
      }
    }
  }).then((message) => upsertMessage(message).then(() => message));

  if (timeoutMs) {
    if (abortController) {
      // This will be called when a timeout occurs in order for us to forcibly
      // ensure that the underlying HTTP request is aborted.
      (response as any).cancel = () => {
        abortController!.abort();
      };
    }

    return pTimeout(response, {
      milliseconds: timeoutMs,
      message: "OpenAI timed out waiting for response",
    });
  } else {
    return response;
  }
}

async function _buildMessages(text: string, opts: SendMessageOptions) {
  let { parentMessageId } = opts;

  const userLabel = USER_LABEL_DEFAULT;
  const assistantLabel = ASSISTANT_LABEL_DEFAULT;

  const maxNumTokens = maxModelTokens - maxResponseTokens;
  let messages: openai.ChatCompletionRequestMessage[] = [];

  if (SYSTEM_MESSAGE) {
    messages.push({
      role: "system",
      content: SYSTEM_MESSAGE,
    });
  }

  const systemMessageOffset = messages.length;
  let nextMessages = text
    ? messages.concat([
        {
          role: "user",
          content: text,
          name: opts.name,
        },
      ])
    : messages;
  let numTokens = 0;

  do {
    const prompt = nextMessages
      .reduce((prompt, message) => {
        switch (message.role) {
          case "system":
            return prompt.concat([`Instructions:\n${message.content}`]);
          case "user":
            return prompt.concat([`${userLabel}:\n${message.content}`]);
          default:
            return prompt.concat([`${assistantLabel}:\n${message.content}`]);
        }
      }, [] as string[])
      .join("\n\n");

    const nextNumTokensEstimate = await getTokenCount(prompt);
    const isValidPrompt = nextNumTokensEstimate <= maxNumTokens;

    if (prompt && !isValidPrompt) {
      break;
    }

    messages = nextMessages;
    numTokens = nextNumTokensEstimate;

    if (!isValidPrompt) {
      break;
    }

    if (!parentMessageId) {
      break;
    }

    const parentMessage = await getMessageById(parentMessageId);
    if (!parentMessage) {
      break;
    }

    const parentMessageRole = parentMessage.role || "user";

    nextMessages = nextMessages.slice(0, systemMessageOffset).concat([
      {
        role: parentMessageRole,
        content: parentMessage.text,
        name: parentMessage.name,
      },
      ...nextMessages.slice(systemMessageOffset),
    ]);

    ({ parentMessageId } = parentMessage);
  } while (true);

  // Use up to 4096 tokens (prompt + response), but try to leave 1000 tokens
  // for the response.
  const maxTokens = Math.max(
    1,
    Math.min(maxModelTokens - numTokens, maxResponseTokens)
  );

  return { messages, maxTokens, numTokens };
}

async function getTokenCount(text: string) {
  // TODO: use a better fix in the tokenizer
  text = text.replace(/<\|endoftext\|>/g, "");

  return encode(text).length;
}

async function getMessageById(id: string): Promise<ChatMessage> {
  const res = await messageStore.get(id);
  return res!;
}

async function upsertMessage(message: ChatMessage): Promise<void> {
  await messageStore.set(message.id, message);
}

interface SendMessageOptions {
  /** The name of a user in a multi-user chat. */
  name?: string;
  /**
   * Optional ID of the previous message in the conversation
   * @default undefined
   */
  parentMessageId?: string;
  /**
   * Optional ID of the message to send (defaults to a random UUID).
   */
  messageId?: string;
  stream?: boolean;
  /**
   * Optional override for the chat "system message" which acts as instructions to the model
   * (defaults to the ChatGPT system message)
   */
  systemMessage?: string;
  /**
   * Optional timeout in milliseconds (defaults to no timeout)
   */
  timeoutMs?: number;
  /**
   * Optional callback which will be invoked every time the partial response is updated
   */
  onProgress?: (partialResponse: ChatMessage) => void;
  /**
   * Optional callback used to abort the underlying `fetch` call using an
   * [AbortController](https://developer.mozilla.org/en-US/docs/Web/API/AbortController)
   */
  abortSignal?: AbortSignal;
  /**
   * Optional overrides to send to the
   * [OpenAI chat completion API](https://platform.openai.com/docs/api-reference/chat/create).
   * Options like `temperature` and `presence_penalty` can be tweaked to change the personality
   * of the assistant.
   */
  completionParams?: Partial<
    Omit<openai.CreateChatCompletionRequest, "messages" | "n" | "stream">
  >;
}

interface ChatMessage {
  id: string;
  text: string;
  role: Role;
  name?: string;
  delta?: string;
  detail?: any;

  // relevant for both ChatGPTAPI and ChatGPTUnofficialProxyAPI
  parentMessageId?: string;
  // only relevant for ChatGPTUnofficialProxyAPI
  conversationId?: string;
}

class ChatGPTError extends Error {
  statusCode?: number;
  statusText?: string;
  isFinal?: boolean;
  accountId?: string;
}

namespace openai {
  export interface CreateChatCompletionDeltaResponse {
    id: string;
    object: "chat.completion.chunk";
    created: number;
    model: string;
    choices: [
      {
        delta: {
          role: Role;
          content?: string;
        };
        index: number;
        finish_reason: string | null;
      }
    ];
  }

  export interface ChatCompletionRequestMessage {
    /**
     * The role of the author of this message.
     */
    role: ChatCompletionRequestMessageRoleEnum;
    /**
     * The contents of the message
     */
    content: string;
    /**
     * The name of the user in a multi-user chat
     */
    name?: string;
  }

  declare const ChatCompletionRequestMessageRoleEnum: {
    readonly System: "system";
    readonly User: "user";
    readonly Assistant: "assistant";
  };

  declare type ChatCompletionRequestMessageRoleEnum =
    typeof ChatCompletionRequestMessageRoleEnum[keyof typeof ChatCompletionRequestMessageRoleEnum];

  interface ChatCompletionResponseMessage {
    /**
     * The role of the author of this message.
     */
    role: ChatCompletionResponseMessageRoleEnum;
    /**
     * The contents of the message
     */
    content: string;
  }

  declare const ChatCompletionResponseMessageRoleEnum: {
    readonly System: "system";
    readonly User: "user";
    readonly Assistant: "assistant";
  };

  declare type ChatCompletionResponseMessageRoleEnum =
    typeof ChatCompletionResponseMessageRoleEnum[keyof typeof ChatCompletionResponseMessageRoleEnum];

  export interface CreateChatCompletionRequest {
    /**
     * ID of the model to use. Currently, only `gpt-3.5-turbo` and `gpt-3.5-turbo-0301` are supported.
     */
    model: string;
    /**
     * The messages to generate chat completions for, in the [chat format](/docs/guides/chat/introduction).
     */
    messages: Array<ChatCompletionRequestMessage>;
    /**
     * What sampling temperature to use, between 0 and 2. Higher values like 0.8 will make the output more random, while lower values like 0.2 will make it more focused and deterministic.  We generally recommend altering this or `top_p` but not both.
     */
    temperature?: number | null;
    /**
     * An alternative to sampling with temperature, called nucleus sampling, where the model considers the results of the tokens with top_p probability mass. So 0.1 means only the tokens comprising the top 10% probability mass are considered.  We generally recommend altering this or `temperature` but not both.
     */
    top_p?: number | null;
    /**
     * How many chat completion choices to generate for each input message.
     */
    n?: number | null;
    /**
     * If set, partial message deltas will be sent, like in ChatGPT. Tokens will be sent as data-only [server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events#Event_stream_format) as they become available, with the stream terminated by a `data: [DONE]` message.
     */
    stream?: boolean | null;
    stop?: CreateChatCompletionRequestStop;
    /**
     * The maximum number of tokens allowed for the generated answer. By default, the number of tokens the model can return will be (4096 - prompt tokens).
     */
    max_tokens?: number;
    /**
     * Number between -2.0 and 2.0. Positive values penalize new tokens based on whether they appear in the text so far, increasing the model\'s likelihood to talk about new topics.  [See more information about frequency and presence penalties.](/docs/api-reference/parameter-details)
     */
    presence_penalty?: number | null;
    /**
     * Number between -2.0 and 2.0. Positive values penalize new tokens based on their existing frequency in the text so far, decreasing the model\'s likelihood to repeat the same line verbatim.  [See more information about frequency and presence penalties.](/docs/api-reference/parameter-details)
     */
    frequency_penalty?: number | null;
    /**
     * Modify the likelihood of specified tokens appearing in the completion.  Accepts a json object that maps tokens (specified by their token ID in the tokenizer) to an associated bias value from -100 to 100. Mathematically, the bias is added to the logits generated by the model prior to sampling. The exact effect will vary per model, but values between -1 and 1 should decrease or increase likelihood of selection; values like -100 or 100 should result in a ban or exclusive selection of the relevant token.
     */
    logit_bias?: object | null;

    /**
     * A unique identifier representing your end-user, which can help OpenAI to monitor and detect abuse. [Learn more](/docs/guides/safety-best-practices/end-user-ids).
     */
    user?: string;
  }

  /**
   * Up to 4 sequences where the API will stop generating further tokens.
   */
  declare type CreateChatCompletionRequestStop = Array<string> | string;

  export interface CreateChatCompletionResponse {
    id: string;
    object: string;
    created: number;
    model: string;
    choices: Array<CreateChatCompletionResponseChoicesInner>;
    usage?: CreateCompletionResponseUsage;
  }

  interface CreateChatCompletionResponseChoicesInner {
    index?: number;
    message?: ChatCompletionResponseMessage;
    finish_reason?: string;
  }

  interface CreateCompletionResponseUsage {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  }
}
