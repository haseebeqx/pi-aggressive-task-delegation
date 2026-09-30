// Custom entries are visible in Pi's transcript but never enter model context.
// A live entry keeps its position; hidden checkpoints restore its final state
// when the supervisor session is reopened.
export const OUTPUT_ENTRY = 'delegation-output';
export const CHECKPOINT_ENTRY = 'delegation-output-checkpoint';

export class DelegationTranscript {
  constructor(append, id) {
    this.append = append;
    this.id = id;
    this.records = new Map();
  }

  restore(entries) {
    this.records.clear();
    for (const entry of entries) {
      if ([OUTPUT_ENTRY, CHECKPOINT_ENTRY].includes(entry.customType) && entry.data?.id) {
        this.records.set(entry.data.id, entry.data);
      }
    }
  }

  start(node, kind, content) {
    const record = { id: this.id(), role: node.role, cwd: node.cwd, kind, ...content };
    this.records.set(record.id, record);
    this.append(OUTPUT_ENTRY, structuredClone(record));
    return record;
  }

  update(record, content, final = false) {
    Object.assign(record, content);
    if (final) this.append(CHECKPOINT_ENTRY, structuredClone(record));
  }
}

export function createTranscriptComponent(getRecord, { AssistantMessageComponent, ToolExecutionComponent, Text }, tui, theme) {
  let assistant;
  let tool;
  let previousMessage;
  let previousTool;
  let previousStreaming;
  return {
    render(width) {
      const record = getRecord();
      if (!record) return [];
      const header = new Text(theme.fg('muted', `Delegated ${record.role}`), 0, 0);
      if (record.kind === 'assistant') {
        assistant ??= new AssistantMessageComponent();
        if (previousMessage !== record.message || previousStreaming !== record.streaming) {
          assistant.updateContent(record.message, record.streaming);
          previousMessage = record.message;
          previousStreaming = record.streaming;
        }
        return [...header.render(width), ...assistant.render(width)];
      }
      if (previousTool !== record.tool) {
        const data = record.tool;
        tool = new ToolExecutionComponent(data.name, data.id, data.args,
          { showImages: false }, undefined, tui, record.cwd);
        tool.markExecutionStarted();
        tool.setArgsComplete();
        tool.setExpanded(true);
        if (data.result) tool.updateResult(data.result, data.partial);
        previousTool = data;
      }
      return [...header.render(width), ...tool.render(width)];
    },
    invalidate() {
      assistant?.invalidate();
      tool?.invalidate();
      previousMessage = undefined;
      previousTool = undefined;
    },
  };
}
