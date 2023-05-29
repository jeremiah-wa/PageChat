import { ChatOpenAI } from "langchain/chat_models/openai";
import {
  HumanChatMessage,
  AIChatMessage,
  BaseChatMessage,
} from "langchain/schema";
import {
  useRef,
  useState,
  useEffect,
  useMemo,
  useCallback,
  FormEvent,
} from "react";
import { useChatHistory } from "../utils/useChatHistory";
import ReactMarkdown from "react-markdown";
import {
  ConversationChain,
  ConversationalRetrievalQAChain,
} from "langchain/chains";
import { BufferMemory } from "langchain/memory";
import {
  ChatPromptTemplate,
  MessagesPlaceholder,
  HumanMessagePromptTemplate,
} from "langchain/prompts";
import { useSettingsStore } from "../utils/useSettingsStore";
import { Select } from "./select/Select";
import { getCurrentPageContent } from "../utils/getPageContent";
import { RecursiveCharacterTextSplitter } from "langchain/text_splitter";
import { MemoryVectorStore } from "langchain/vectorstores/memory";
import { OpenAIEmbeddings } from "langchain/embeddings/openai";
import { VectorStore } from "langchain/vectorstores/base";
import { ChatMode } from "./SettingsProvider";

function ChatMessageRow({ message }: { message: BaseChatMessage }) {
  return (
    <div
      style={{
        display: "flex",
        gap: "0.5rem",
        padding: "0.5rem 0",
      }}
    >
      <span>{message instanceof HumanChatMessage ? "You: " : "Bot: "}</span>
      <div>
        <ReactMarkdown children={message.text} />
      </div>
    </div>
  );
}

const ChatModeOptions = [
  {
    label: "Chat with the current page",
    value: "with-page",
  },
  {
    label: "Chat with GPT-3.5",
    value: "with-llm",
  },
];

export function Chatbot() {
  const { settings, setSettings } = useSettingsStore();
  const { openAIApiKey, chatMode = "with-page" } = settings;
  const formRef = useRef<HTMLFormElement | null>(null);
  const outputPanelRef = useRef<HTMLDivElement | null>(null);
  const [, history, setHistory] = useChatHistory([], chatMode);
  const [userInput, setUserInput] = useState("");
  const [userInputAwaitingResponse, setUserInputAwaitingResponse] = useState<
    string | undefined
  >();
  const [generating, setGenerating] = useState(false);
  const [responseStream, setResponseStream] = useState("");
  const [error, setError] = useState<string | undefined>();
  const abortControllerRef = useRef<AbortController | undefined>(undefined);
  const [pageContentVectorStore, setPageContentVectorStore] =
    useState<VectorStore>();

  useEffect(() => {
    outputPanelRef.current?.scrollTo(0, outputPanelRef.current.scrollHeight);
  }, [history, userInputAwaitingResponse, responseStream]);

  useEffect(() => {
    let ignore = false;

    async function loadPageIntoVectorStore() {
      const pageContent = await getCurrentPageContent();
      if (!pageContent?.pageContent) return;

      const textSplitter = new RecursiveCharacterTextSplitter({
        chunkSize: 4000,
      });

      const docs = await textSplitter.createDocuments([
        pageContent.pageContent,
      ]);

      const vectorStore = await MemoryVectorStore.fromDocuments(
        docs,
        new OpenAIEmbeddings({ openAIApiKey })
      );

      if (ignore) return;

      setPageContentVectorStore(vectorStore);
    }

    if (chatMode === "with-page") {
      loadPageIntoVectorStore();
    }

    return () => {
      ignore = true;
    };
  }, [chatMode, openAIApiKey]);

  const chain = useMemo(() => {
    const llm = new ChatOpenAI({
      openAIApiKey: openAIApiKey,
      // temperature: 0,
      streaming: true,
      verbose: true,
      callbacks: [
        {
          handleLLMNewToken(token: string) {
            setResponseStream((streamingText) => streamingText + token);
          },
          handleLLMEnd() {
            setResponseStream("");
          },
        },
      ],
    });

    if (chatMode === "with-page" && pageContentVectorStore) {
      return ConversationalRetrievalQAChain.fromLLM(
        llm,
        pageContentVectorStore.asRetriever(),
        {
          verbose: true,
          returnSourceDocuments: true,
        }
      );
    }

    return new ConversationChain({
      memory: new BufferMemory({
        returnMessages: true,
        /**
         * inputKey is required if you are passing other non-input values when invoking chain.call
         */
        inputKey: "input",
        memoryKey: "history",
        // chatHistory: new ChatMessageHistory(history),
        chatHistory: {
          async getMessages() {
            return history;
          },
          async addUserMessage(message) {
            setHistory((history) => [
              ...history,
              new HumanChatMessage(message),
            ]);
          },
          async addAIChatMessage(message) {
            setHistory((history) => [...history, new AIChatMessage(message)]);
          },
          async clear() {
            setHistory([]);
          },
        },
      }),
      llm: llm,
      prompt: ChatPromptTemplate.fromPromptMessages([
        // new SystemChatMessage("Answer the following question:"),
        new MessagesPlaceholder("history"),
        HumanMessagePromptTemplate.fromTemplate("{input}"),
      ]),
    });
  }, [openAIApiKey, chatMode, pageContentVectorStore, history, setHistory]);

  const sendUserMessage = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();

      setGenerating(true);

      try {
        abortControllerRef.current = new AbortController();

        // const message = new HumanChatMessage(messageText);
        // setHistory((history) => [...history, message]);
        // setMessageText("");
        // const response = await llm.call(
        //   [
        //     // new SystemChatMessage("Answer the following question:"),
        //     ...history,
        //     message,
        //   ],
        //   { signal: controller.signal }
        // );
        // setHistory((history) => [...history, response]);

        setUserInputAwaitingResponse(userInput);
        setUserInput("");

        if (chain instanceof ConversationChain) {
          const response = await chain.call({
            input: userInput,
            signal: abortControllerRef.current?.signal,
          });

          console.log({
            response,
            // history,
            outputKey: chain.outputKey,
          });
        } else if (chain instanceof ConversationalRetrievalQAChain) {
          const response = await chain.call({
            question: userInput,
            chat_history: history.map((message) => message.text),
            signal: abortControllerRef.current?.signal,
          });

          setHistory((history) => [
            ...history,
            new HumanChatMessage(userInput),
            new AIChatMessage(response.text),
          ]);

          console.log({
            response,
            // history,
          });
        }
      } catch (error) {
        console.error(error);
        if (!abortControllerRef.current?.signal.aborted) {
          setError(`${error}`);
        }
      } finally {
        setGenerating(false);
        setUserInputAwaitingResponse(undefined);
        abortControllerRef.current = undefined;
      }
    },
    [chain, history, setHistory, userInput]
  );

  const stopGenerating = useCallback(() => {
    abortControllerRef.current?.abort();
  }, []);

  const clearHistory = useCallback(async () => {
    setHistory([]);
  }, [setHistory]);

  return (
    <>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "1rem",
          alignItems: "stretch",
        }}
      >
        <Select
          options={ChatModeOptions}
          value={chatMode}
          onChange={(e) =>
            setSettings({
              ...settings,
              chatMode: e.target.value as ChatMode,
            })
          }
        />
        {(history.length > 0 ||
          userInputAwaitingResponse ||
          responseStream ||
          error) && (
          <div
            ref={outputPanelRef}
            style={{
              border: "1px solid lightgray",
              padding: "1rem",
              textAlign: "left",
              maxHeight: "20rem",
              overflowY: "auto",
            }}
          >
            {history.map((message, index) => {
              return <ChatMessageRow key={index} message={message} />;
            })}
            {userInputAwaitingResponse && (
              <ChatMessageRow
                message={new HumanChatMessage(userInputAwaitingResponse)}
              />
            )}
            {responseStream && (
              <ChatMessageRow message={new AIChatMessage(responseStream)} />
            )}
            {error && (
              <ChatMessageRow message={new AIChatMessage(`Error: ${error}`)} />
            )}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "space-between" }}>
          {(history.length > 0 || userInputAwaitingResponse) && (
            <>
              {!generating && (
                <button
                  onClick={() => {
                    const lastHumanMessageIndex = history.findLastIndex(
                      (message) => message instanceof HumanChatMessage
                    );
                    if (lastHumanMessageIndex !== -1) {
                      setUserInput(history[lastHumanMessageIndex].text);
                      setHistory([...history.slice(0, lastHumanMessageIndex)]);

                      setTimeout(() => {
                        // Submit the form
                        formRef.current?.dispatchEvent(
                          new Event("submit", {
                            cancelable: true,
                            bubbles: true,
                          })
                        );
                      });
                    }
                  }}
                >
                  Regenerate Response
                </button>
              )}
              {generating && (
                <button onClick={stopGenerating}>Stop Generating</button>
              )}
              <button onClick={clearHistory} disabled={generating}>
                Clear History
              </button>
            </>
          )}
        </div>

        <form ref={formRef} onSubmit={sendUserMessage}>
          <textarea
            id="message"
            placeholder="Send a message"
            style={{
              boxSizing: "border-box",
              padding: "0.5rem",
              width: "100%",
              resize: "vertical",
            }}
            value={userInput}
            onChange={(e) => setUserInput(e.target.value)}
            disabled={generating}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                // Don't generate a new line
                event.preventDefault();

                // Submit the form
                formRef.current?.dispatchEvent(
                  new Event("submit", { cancelable: true, bubbles: true })
                );
              }
            }}
            onResize={(event) => event.preventDefault()}
          />
        </form>
      </div>
    </>
  );
}

export default Chatbot;
