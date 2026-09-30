// UI-independent focus and cancellation state. Each scope is one worker/review
// pair; sessions are nodes so recursive tasks retain their immediate parent.
export class DelegationView {
  constructor(render = () => {}) {
    this.render = render;
    this.focus = undefined;
    this.scopes = new Set();
  }

  open(parent, signal) {
    const controller = new AbortController();
    const scope = { parent, controller, cancelled: false };
    const abort = () => {
      controller.abort(signal?.reason);
      scope.resume?.();
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    scope.cleanup = () => signal?.removeEventListener('abort', abort);
    this.scopes.add(scope);
    return scope;
  }

  enter(scope, session, role, task) {
    const node = { scope, parent: scope.parent, session, role, task,
      usage: undefined, activity: '', text: '' };
    this.focus = node;
    this.render(node);
    return node;
  }

  update(node) {
    if (this.focus === node) this.render(node);
  }

  leave(node) {
    if (this.focus === node) {
      this.focus = node.parent;
      this.render(this.focus);
    }
  }

  cancel() {
    const node = this.focus;
    if (!node?.scope) return false;
    const scope = node.scope;
    if (scope.cancelled) return false;
    scope.cancelled = true;
    scope.wait = new Promise((resolve) => { scope.resume = resolve; });
    // Input now belongs to the parent even while the child unwinds.
    this.focus = scope.parent;
    scope.parent.waiting = scope;
    scope.controller.abort(new Error('Cancelled by user'));
    // A parent's cancellation must also release descendant intervention waits.
    for (const child of this.scopes) {
      let parent = child.parent;
      while (parent?.scope) {
        if (parent.scope === scope) {
          child.controller.abort(new Error('Parent cancelled'));
          child.resume?.();
          break;
        }
        parent = parent.parent;
      }
    }
    this.render(this.focus);
    return true;
  }

  async input(text, images) {
    const node = this.focus;
    if (!node) return false;
    // Queue guidance before releasing the parent's delegate_task call.
    await node.session.steer(text, images);
    if (node.waiting) {
      node.waiting.resume?.();
      node.waiting = undefined;
    }
    this.render(node);
    return true;
  }

  async finish(scope) {
    if (scope.cancelled && !scope.parent.scope?.controller.signal.aborted) {
      await scope.wait;
    }
    if (scope.parent.waiting === scope) scope.parent.waiting = undefined;
    scope.cleanup();
    this.scopes.delete(scope);
    if (this.focus === scope.parent && !scope.parent.scope && !scope.parent.waiting) {
      this.focus = undefined;
      this.render(undefined);
    }
  }

  shutdown() {
    for (const scope of this.scopes) {
      scope.controller.abort();
      scope.resume?.();
      scope.cleanup();
    }
    this.focus = undefined;
    this.render(undefined);
  }
}
