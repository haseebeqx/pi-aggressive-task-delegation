// Reuse Pi's native footer instead of maintaining a second usage display.
export class DelegationFooter {
  constructor(FooterComponent, onError = () => {}) {
    this.FooterComponent = FooterComponent;
    this.onError = onError;
  }

  focus(ui, node) {
    const session = node?.role !== 'main' ? node?.session : undefined;
    if (this.ui && (this.ui !== ui || !session)) this.restore();
    if (!ui || !session) return;
    if (!this.ui) {
      // Assign ownership before installation so failure cleanup restores Pi.
      this.ui = ui;
      ui.setFooter((tui, _theme, footerData) => {
        this.tui = tui;
        this.component = new this.FooterComponent(session, footerData);
        return this.component;
      });
    }
    this.session = session;
    this.component?.setSession(session);
    this.component?.setAutoCompactEnabled(session.autoCompactionEnabled);
    this.tui?.requestRender();
  }

  refresh(node) {
    if (this.session !== node.session) return;
    // SDK message_end listeners run before persistence. Render on the next
    // microtask so the native footer reads the newly appended usage entries.
    queueMicrotask(() => {
      if (this.session !== node.session) return;
      try {
        this.component?.setAutoCompactEnabled(node.session.autoCompactionEnabled);
        this.tui?.requestRender();
      } catch (error) {
        this.onError(error);
      }
    });
  }

  restore() {
    const ui = this.ui;
    this.ui = this.session = this.component = this.tui = undefined;
    ui?.setFooter(undefined);
  }
}
