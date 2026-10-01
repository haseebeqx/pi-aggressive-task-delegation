// ExtensionToolContext is Pi's public, permission-aware tool bridge. Reuse the
// supervisor's live runtime instead of loading extensions (and their UI) again.
export function inheritTools(parentCtx, delegateTool) {
  if (!Array.isArray(parentCtx.tools) || typeof parentCtx.executeTool !== 'function') {
    throw new Error('Tool inheritance requires Pi ExtensionToolContext.tools and executeTool (tested with Pi 0.99.2).');
  }
  const customTools = parentCtx.tools.filter((tool) => tool.name !== 'delegate_task')
    .map((tool) => {
      const { execute: _execute, prepareLoadout: _prepareLoadout, ...definition } = tool;
      return {
        ...definition,
        // Include deferred/codemode tools directly: no discovery extension needs
        // to be restarted, and every callable tool is available to each child.
        exposure: 'direct',
        async execute(_id, args, signal, onUpdate) {
          const outcome = await parentCtx.executeTool(tool.name, args, { signal, onUpdate });
          // Pi already adds nested usage to the supervisor's calling tool. Do
          // not add it again via the child's delegation report.
          const { usage: _usage, ...result } = outcome.result;
          return { ...result, isError: outcome.isError };
        },
      };
    });
  // Never forward this tool to the parent: recursion needs a child-local queue,
  // context, session manager and focus parent (also for reviewers).
  customTools.push(delegateTool);
  return { tools: customTools.map((tool) => tool.name), customTools };
}
