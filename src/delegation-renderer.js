// Only routing and usage stay pinned. Output lives in the normal transcript.
export function createDelegationWidgets(node, { Text }) {
  const path = [];
  for (let current = node; current; current = current.parent) {
    path.unshift(current.role === 'main' ? 'Main' : current.role);
  }
  return {
    content: (tui, theme) => {
      const usage = node.usage;
      const header = new Text(theme.fg('muted', path.join(' → ')), 0, 0);
      const activity = new Text(theme.fg('muted', node.waiting
        ? 'Cancelled child. What should this parent do instead? Type your instruction.'
        : `${node.activity || 'Working'} · Input steers this session · Ctrl+Esc: parent`), 0, 0);
      const stats = new Text(theme.fg('dim', `Tokens: ${usage?.input ?? 0} in / ${usage?.output ?? 0} out / ${usage?.cacheRead ?? 0} cache read / ${usage?.cacheWrite ?? 0} cache write · Cost: $${(usage?.cost.total ?? 0).toFixed(4)}`), 0, 0);
      return {
        render(width) {
          return [...header.render(width), ...activity.render(width), ...stats.render(width)];
        },
        invalidate() {
          for (const component of [header, activity, stats]) component?.invalidate();
        },
      };
    },
    indicator: (_tui, theme) => new Text(theme.style(
      node.role === 'main' ? 'Main session · Delegated task cancelled — awaiting instruction'
        : `Delegated task · ${node.role} · Ctrl+Esc: cancel and return to parent`,
      { fg: { kind: 'rgb', r: 255, g: 149, b: 0 }, bold: true }), 0, 0),
  };
}

export function updateDelegationMessage(node, event) {
  if (['message_start', 'message_update', 'message_end'].includes(event.type) &&
      event.message.role === 'assistant') {
    node.message = event.message;
    node.streaming = event.type !== 'message_end';
    if (event.type === 'message_start') node.tool = undefined;
    return true;
  }
  if (event.type === 'tool_execution_start') {
    node.tool = { id: event.toolCallId, name: event.toolName, args: event.args };
    node.activity = `Tool: ${event.toolName}`;
    return true;
  }
  if (event.type === 'tool_execution_update' || event.type === 'tool_execution_end') {
    // A focused parent can receive updates while its recursive child is visible.
    if (node.tool?.id !== event.toolCallId) return false;
    node.tool.result = { ...(event.partialResult ?? event.result), isError: event.isError ?? false };
    node.tool.partial = event.type === 'tool_execution_update';
    node.activity = `Tool: ${event.toolName}${node.tool.partial ? '' : ' finished'}`;
    return true;
  }
  return false;
}
