// Minimal DSH 0.2.2-rc.1 ACP presentation fixture; unrelated session logic omitted.
function toolCallUpdate(event) {
	return {
		sessionUpdate: "tool_call",
		toolCallId: event.data.callId,
		title: event.data.name,
		kind: "other",
		status: "in_progress",
		rawInput: parseToolArguments(event.data.arguments)
	};
}
/**
* Finish one generic ACP tool lifecycle from its committed model-facing result.
* @param ctx - bridge context carrying the attachment store.
* @param event - committed DSH tool-result event.
* @returns the standard completed or failed tool-call update.
*/
async function toolResultUpdate(ctx, event) {
	const message = event.data.message;
	const content = [];
	for (const block of message.content) {
		const converted = await assistantBlockToAcp(ctx, block);
		if (converted !== void 0) content.push({
			type: "content",
			content: converted
		});
	}
	return {
		sessionUpdate: "tool_call_update",
		toolCallId: message.toolCallId,
		status: message.isError === true ? "failed" : "completed",
		content
	};
}
class SessionFixture {
	outputTail = Promise.resolve();
	inflight;
	onEvent(event) {
			if (false) {
			} else if (event.type === "tool/call") {
				const previous = this.outputTail;
				this.outputTail = previous.then(() => this.notify({
					sessionId: this.agent.session.id,
					update: toolCallUpdate(event)
				})).catch((error) => {
					this.ctx.logger.warn(`acp: tool-call update delivery failed: ${errorChain(error)}`);
				});
			} else if (event.type === "tool/result") {
				const previous = this.outputTail;
				this.outputTail = previous.then(async () => this.notify({
					sessionId: this.agent.session.id,
					update: await toolResultUpdate(this.ctx, event)
				})).catch((error) => {
					this.ctx.logger.warn(`acp: tool-result update delivery failed: ${errorChain(error)}`);
				});
			}
	}
}
