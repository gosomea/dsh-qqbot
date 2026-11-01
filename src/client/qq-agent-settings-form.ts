import { createElement as h, useState, type ChangeEvent, type ReactNode } from 'react';
import { Button, Checkbox, Input, Modal, Switch } from '@deepseek-ai/dsh-client-ui-primitives';
import type { QQAgentSettings, QQExecutionSettings } from '../shared/agent-settings.ts';
import type { ConversationSandboxMode, SlashCommandDescriptor, ToolCatalogEntry } from '../shared/conversation-protocol.ts';
import { defaultModelLabel, defaultPresetLabel, findModel, modelChoiceId, modelLabel, presetLabel } from './host-selectors.ts';
import type { QQAgentCatalog } from './qq-agent-catalog.ts';
import { QQSelect, type QQSelectOption } from './qq-controls.ts';

const PERMISSIONS: ReadonlyArray<{ value: ConversationSandboxMode; label: string }> = [
  { value: 'read-only', label: '仅可查看' },
  { value: 'workspace-write', label: '工作区内修改' },
  { value: 'danger-full-access', label: '完全权限' },
];
const CATEGORIES: Record<ToolCatalogEntry['category'], string> = { file: '文件', search: '搜索', network: '联网', execution: '命令与代码', mcp: 'MCP', attachment: '附件与交付', other: '其他' };

export interface QQAgentSettingsFormProps {
  readonly settings: QQAgentSettings;
  readonly tools: readonly ToolCatalogEntry[];
  readonly catalog: QQAgentCatalog;
  readonly disabled?: boolean;
  readonly askTools?: readonly string[];
  readonly onChange: (settings: QQAgentSettings) => void;
  readonly onRefreshCatalog: () => void;
  /** Slash-command metadata from the registry (single source of truth); omitted hides the list. */
  readonly commands?: readonly SlashCommandDescriptor[];
  /** Open the Host directory picker to fill the working directory; omitted hides the browse button. */
  readonly onPickDirectory?: () => Promise<string | null>;
}

/** Draft fields only. The parent owns persistence, versions and conflict handling. */
export function QQAgentSettingsForm({ settings, tools, catalog, disabled = false, askTools = [], commands = [], onPickDirectory, onChange, onRefreshCatalog }: QQAgentSettingsFormProps): ReactNode {
  const [query, setQuery] = useState('');
  const [toolsOpen, setToolsOpen] = useState(false);
  const execution = settings.execution;
  const model = settings.model;
  const modelOptions: QQSelectOption[] = [{ value: 'inherit', label: defaultModelLabel(catalog.models) }];
  if (model && !findModel(catalog.models, model)) modelOptions.push({ value: modelChoiceId(model), label: modelLabel(catalog.models, model), disabled: true });
  for (const group of catalog.models?.groups ?? []) for (const choice of group.models) modelOptions.push({ value: modelChoiceId(choice), label: `${group.name} / ${choice.name}`, description: choice.description });
  const presetOptions: QQSelectOption[] = [{ value: '', label: defaultPresetLabel(catalog.presets === null ? null : [...catalog.presets]) }];
  if (settings.preset && !catalog.presets?.some(preset => preset.id === settings.preset)) presetOptions.push({ value: settings.preset, label: presetLabel(catalog.presets === null ? null : [...catalog.presets], settings.preset), disabled: true });
  for (const preset of catalog.presets ?? []) presetOptions.push({ value: preset.id, label: `${preset.name}${preset.broken ? '（不可用）' : ''}`, description: preset.broken ?? preset.description, disabled: Boolean(preset.broken) });
  const selected = new Set(execution.kind === 'custom' ? execution.tools : []);
  const search = query.trim().toLocaleLowerCase();
  const available: ToolCatalogEntry[] = [...tools, ...[...selected].filter(id => !tools.some(tool => tool.id === id)).map(id => ({ id, name: id, description: '当前目录不可用，已保留原选择。', category: 'other', constraint: 'none', available: false } satisfies ToolCatalogEntry))];
  const visible = available.filter(tool => `${tool.name} ${tool.id} ${tool.description}`.toLocaleLowerCase().includes(search));
  const setExecution = (next: QQExecutionSettings): void => onChange({ ...settings, execution: next });
  const setTools = (values: Iterable<string>): void => setExecution({ kind: 'custom', permission: execution.permission, tools: [...new Set(values)].sort() });
  return h('div', { className: 'imqc-agentSettings' },
    h('div', { className: 'imqc-field' }, h('span', null, '模型'), h(QQSelect, { label: '模型', value: model ? modelChoiceId(model) : 'inherit', options: modelOptions, disabled, onOpen: onRefreshCatalog, onChange: value => {
      if (value === 'inherit') { onChange({ ...settings, model: null }); return; }
      const choice = catalog.models?.groups.flatMap(group => group.models).find(candidate => modelChoiceId(candidate) === value);
      if (choice) onChange({ ...settings, model: { provider: choice.provider, model: choice.model } });
    } })),
    h('div', { className: 'imqc-field' }, h('span', null, 'Agent 预设'), h(QQSelect, { label: 'Agent 预设', value: settings.preset, options: presetOptions, disabled, onOpen: onRefreshCatalog, onChange: preset => onChange({ ...settings, preset }) })),
    h('p', { className: 'imqc-hint' }, 'Agent 预设决定使用哪个 Agent；执行权限决定该 Agent 可执行的操作。'),
    h('div', { className: 'imqc-field' }, h('span', null, '执行权限'), h(QQSelect, { label: '执行权限', value: execution.kind === 'custom' ? 'custom' : execution.permission, disabled, options: [...PERMISSIONS, { value: 'custom', label: '自定义工具' }], onChange: value => {
      if (value === 'custom') { setExecution({ kind: 'custom', permission: execution.permission, tools: [] }); return; }
      const permission = PERMISSIONS.find(item => item.value === value)?.value;
      if (permission) setExecution({ kind: 'native', permission });
    } })),
    execution.kind === 'native' ? h('p', { className: 'imqc-hint' }, '使用所选 Agent 的实际工具，并遵循 DSH 原生权限。') : h('section', { className: 'imqc-fieldset imqc-customTools', 'aria-label': '自定义工具集' },
      h('div', { className: 'imqc-fieldsetTitle' }, '自定义工具集'),
      h('p', { className: 'imqc-hint' }, '仅开放下方勾选的工具；基础权限是这些工具之上的上限，文件、命令和网络操作仍受其限制，已有额外审批规则保留。'),
      h('div', { className: 'imqc-field' }, h('span', null, '基础上限'), h(QQSelect, { label: '自定义工具的基础权限', value: execution.permission, options: PERMISSIONS, disabled, onChange: value => { const permission = PERMISSIONS.find(item => item.value === value)?.value; if (permission) setExecution({ ...execution, permission }); } })),
      h(Button, { variant: 'outline', size: 'sm', disabled, onClick: () => setToolsOpen(true) }, `选择工具（已选 ${selected.size} 项）`),
      toolsOpen ? h(Modal, { open: true, title: '选择可用工具', closeLabel: '关闭工具选择', onClose: () => setToolsOpen(false), children: h('div', { className: 'imqc' },
      h(Input, { type: 'search', value: query, disabled, placeholder: '搜索工具名称或标识', 'aria-label': '搜索工具', onChange: (event: ChangeEvent<HTMLInputElement>) => setQuery(event.target.value) }),
      h('div', { className: 'imqc-actions' }, h(Button, { variant: 'ghost', size: 'sm', disabled: disabled || !visible.some(tool => tool.available), onClick: () => setTools([...selected, ...visible.filter(tool => tool.available).map(tool => tool.id)]) }, '全选当前筛选'), h(Button, { variant: 'ghost', size: 'sm', disabled: disabled || selected.size === 0, onClick: () => setTools([]) }, '清空选择'), h('span', { className: 'imqc-hint' }, `已选 ${selected.size} 项`)),
      h('div', { className: 'imqc-toolChoices' }, ...Object.entries(CATEGORIES).map(([category, label]) => ({ category, label, tools: visible.filter(tool => tool.category === category) })).filter(group => group.tools.length).map(group => h('section', { key: group.category, className: 'imqc-toolGroup' }, h('strong', null, group.label), ...group.tools.map(tool => h('div', { className: 'imqc-tool', key: tool.id }, h('div', { title: tool.description }, h('span', null, tool.name), tool.id !== tool.name ? h('small', { className: 'imqc-hint' }, tool.id) : null, !tool.available ? h('small', { className: 'imqc-hint' }, tool.reason ?? '当前不可用') : null, askTools.includes(tool.id) ? h('small', { className: 'imqc-hint' }, '需额外审批') : null), h(Checkbox, { className: 'imqc-toolCheckbox', label: `启用${tool.name}`, checked: selected.has(tool.id), disabled: disabled || (!tool.available && !selected.has(tool.id)), onChange: checked => setTools(checked ? [...selected, tool.id] : [...selected].filter(id => id !== tool.id)) })))))),
      visible.length === 0 ? h('p', { className: 'imqc-hint' }, '没有匹配的工具。') : null,
      h(Button, { variant: 'primary', size: 'sm', onClick: () => setToolsOpen(false) }, '完成选择')) }) : null),
    h('div', { className: 'imqc-field' }, h('span', null, '工作目录'),
      h('div', { className: 'imqc-inline' }, h(Input, { value: settings.cwd, disabled, placeholder: '留空使用 QQ 默认工作目录', 'aria-label': '工作目录', onChange: (event: ChangeEvent<HTMLInputElement>) => onChange({ ...settings, cwd: event.target.value }) }),
        onPickDirectory ? h(Button, { variant: 'outline', size: 'sm', disabled, onClick: () => { void onPickDirectory().then(path => { if (path) onChange({ ...settings, cwd: path }); }); } }, '选择目录…') : null)),
    h('label', { className: 'imqc-field' }, h('span', null, '补充提示词'), h('textarea', { rows: 4, value: settings.prompt, disabled, maxLength: 20_000, 'aria-label': '补充提示词', onChange: (event: ChangeEvent<HTMLTextAreaElement>) => onChange({ ...settings, prompt: event.target.value }) })),
    h('div', { className: 'imqc-inline' }, h('span', null, '斜杠命令'), h(Switch, { label: '斜杠命令', checked: settings.slashCommands, disabled, onChange: slashCommands => onChange({ ...settings, slashCommands }) })),
    h('p', { className: 'imqc-hint' }, '关闭后，普通用户的 / 命令返回停用提示；机器人所有者仍可使用命令。'),
    h('details', { className: 'imqc-cmdList' }, h('summary', null, `查看支持的斜杠命令（${commands.length} 个）`),
      commands.length === 0 ? h('p', { className: 'imqc-hint' }, '暂无可用命令。') : null,
      ...(['agent', 'qqbot'] as const).map((category) => {
        const items = commands.filter((command) => command.category === category && command.hidden !== true);
        if (items.length === 0) return null;
        return h('div', { className: 'imqc-cmdGroup', key: category },
          h('strong', null, category === 'agent' ? '通用能力' : 'QQ 内置'),
          ...items.map((command) => h('div', { className: 'imqc-cmdRow', key: command.name },
            h('code', null, `/${command.name}`),
            command.aliases.length ? h('span', { className: 'imqc-hint' }, `（别名 /${command.aliases.join('、/')}）`) : null,
            h('span', { className: 'imqc-hint' }, command.description))));
      })),
    catalog.loading ? h('p', { role: 'status', className: 'imqc-hint' }, '正在读取宿主模型和 Agent 预设目录…') : null,
    [...catalog.errors, ...(catalog.models?.failures ?? [])].map((error, index) => h('p', { key: index, role: 'alert', className: 'imqc-error' }, error)),
    catalog.errors.length ? h(Button, { variant: 'ghost', size: 'sm', disabled: disabled || catalog.loading, onClick: onRefreshCatalog }, '重试读取宿主目录') : null);
}
