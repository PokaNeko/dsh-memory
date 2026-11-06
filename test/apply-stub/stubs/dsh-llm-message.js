/** dsh-llm/message 桩 —— createUserMessage 只保留 apply 用到的字段。 */
export function createUserMessage({ content, source }) {
	return { role: 'user', content, source };
}