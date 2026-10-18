import type { ChatStepRecord } from "@buildwarden/shared";
import { BuildWardenClientProvider, RunUserInputRequestCard } from "@buildwarden/renderer/response-content";
import { readUserInputAnswers, readUserInputQuestions } from "@buildwarden/renderer/logic";
import { useMobileApp } from "../data/mobile-app-context";
import { parseStepMetadata } from "../lib/chat-steps";

export function ChatUserInput({ step, active }: { step: ChatStepRecord; active: boolean }) {
  const { client } = useMobileApp();
  const metadata = parseStepMetadata(step.metadataJson);
  const questions = readUserInputQuestions(metadata);
  const requestId = metadata.userInputRequestId;
  if (!questions.length || typeof requestId !== "string") return null;
  return <div className="mx-3 my-2"><BuildWardenClientProvider client={client}>
    <RunUserInputRequestCard key={requestId} runId={step.chatId} requestId={requestId}
      title={step.title} content={step.content} timestamp={new Date(step.createdAt).toLocaleTimeString()}
      questions={questions} answers={readUserInputAnswers(metadata)} resolved={metadata.requestStatus === "resolved"}
      disabled={!active || metadata.requestStatus !== "opened" || !client.capabilities.chatMutations}
      onSubmitAnswers={(answers) => client.respondToChatUserInput(step.chatId, requestId, answers)} />
  </BuildWardenClientProvider></div>;
}
