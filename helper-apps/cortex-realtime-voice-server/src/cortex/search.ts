import {type ChatMessage, type CortexVariables, getCortexResponse} from "./utils";

const SEARCH_QUERY = `
query Search($text: String, $contextId: String, $chatHistory: [MultiMessage], $aiName: String) {
  sys_entity_agent(text: $text, contextId: $contextId, chatHistory: $chatHistory, aiName: $aiName, voiceResponse: true) {
    result
    tool
    errors
    warnings
  }
}
`

export async function search(contextId: string,
                             aiName: string,
                             chatHistory: ChatMessage[],
                             text: string) {
  const variables: CortexVariables = {
    chatHistory,
    contextId,
    aiName,
    text
  }

  const res = await getCortexResponse(variables, SEARCH_QUERY);

  return res.sys_entity_agent;
}
