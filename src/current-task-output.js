import { AssistantMessageComponent, ToolExecutionComponent } from '@earendil-works/pi-coding-agent';

// Ephemeral child transcript, rendered with Pi's own session components.
export function createCurrentTaskOutput(ui, cwd) {
  let records = [];
  let tools = new Map();
  let refresh = () => {};
  let activeTui;
  const mount = () => ui.setWidget('delegate-list', (tui) => {
    activeTui = tui;
    refresh = () => tui.requestRender();
    return {
      render: (width) => records.flatMap(component => component.render(width)),
      invalidate: () => records.forEach(component => component.invalidate()),
    };
  });
  let assistant;
  return ({ reset, event, toolDefinition }) => {
    if (reset) {
      records = [];
      tools = new Map();
      assistant = undefined;
      mount();
      refresh();
      return;
    }
    if (['message_start', 'message_update', 'message_end'].includes(event.type) && event.message?.role === 'assistant') {
      if (!assistant || event.type === 'message_start') {
        assistant = new AssistantMessageComponent();
        records.push(assistant);
      }
      assistant.updateContent(event.message, event.type !== 'message_end');
      if (event.type === 'message_end') assistant = undefined;
    } else if (event.type === 'tool_execution_start') {
      // The widget factory supplies Pi's live TUI to tool components.
      const component = uiTool(event, toolDefinition);
      tools.set(event.toolCallId, component);
      records.push(component);
    } else if (['tool_execution_update', 'tool_execution_end'].includes(event.type)) {
      tools.get(event.toolCallId)?.updateResult({ ...(event.partialResult ?? event.result), isError: event.isError ?? false }, event.type !== 'tool_execution_end');
    }
    refresh();
  };
  function uiTool(event, toolDefinition) {
    const component = new ToolExecutionComponent(event.toolName, event.toolCallId, event.args,
      { showImages: false }, toolDefinition, activeTui ?? { requestRender: () => refresh() }, cwd);
    component.markExecutionStarted();
    component.setArgsComplete();
    return component;
  }
}
