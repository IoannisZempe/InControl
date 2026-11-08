/**
 * InControl JavaScript / TypeScript SDK for Custom Agents.
 *
 * Example:
 *   import { InControlAgent } from 'incontrol-agents/sdk';
 *   const agent = new InControlAgent({ name: 'DeployBot', ide: 'Node.js' });
 *   await agent.working('Deploying staging cluster', 'Running kubectl apply');
 *   const reply = await agent.askHuman('Promote staging to production?', ['Promote', 'Abort']);
 */
export class InControlAgent {
  constructor(config = {}) {
    this.hubUrl = (config.hubUrl || process.env.INCONTROL_URL || 'http://localhost:4747').replace(/\/$/, '');
    this.id = config.id || `custom-${(config.name || 'agent').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    this.name = config.name || 'Custom Agent';
    this.provider = config.provider || 'custom';
    this.ide = config.ide || 'Custom Runtime';
    this.workspace = config.workspace || process.cwd();
    this.branch = config.branch || 'main';
  }

  async report({ status = 'working', currentTask, currentStep, attentionReason } = {}) {
    const res = await fetch(`${this.hubUrl}/api/agents/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: this.id,
        name: this.name,
        provider: this.provider,
        ide: this.ide,
        workspace: this.workspace,
        branch: this.branch,
        status,
        currentTask,
        currentStep,
        attentionReason,
        incrementTools: status === 'working',
        logMessage: currentStep || currentTask,
      }),
    });
    return res.json();
  }

  async working(currentTask, currentStep) {
    return this.report({ status: 'working', currentTask, currentStep });
  }

  async needsAttention(currentStep, attentionReason) {
    return this.report({ status: 'needs_attention', currentStep, attentionReason });
  }

  async idle(currentStep = 'Standing by') {
    return this.report({ status: 'idle', currentStep });
  }

  /**
   * Blocks and waits for the user to respond from the Mac Side Panel or Phone.
   */
  async askHuman(question, options = ['Approve', 'Deny'], extra = {}) {
    const formattedOptions = options.map((opt, idx) =>
      typeof opt === 'string'
        ? {
            id: opt.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
            label: opt,
            style: idx === 0 ? 'primary' : idx === options.length - 1 ? 'danger' : 'secondary',
          }
        : opt
    );

    const res = await fetch(`${this.hubUrl}/api/agents/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: this.id,
        name: this.name,
        provider: this.provider,
        ide: this.ide,
        workspace: this.workspace,
        branch: this.branch,
        wait: extra.wait !== false,
        question,
        command: extra.command || null,
        details: extra.details || null,
        options: formattedOptions,
        allowFreeText: extra.allowFreeText !== false,
      }),
    });
    return res.json();
  }
}
