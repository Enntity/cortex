import test from 'ava';
import searchMemoryTool from '../../pathways/system/entity/tools/sys_tool_search_continuity_memory.js';
import workspaceSshTool from '../../pathways/system/entity/tools/sys_tool_workspace_ssh.js';

test('SearchMemory exposes optional userMessage and icon for tool status UI', (t) => {
  const definition = searchMemoryTool.toolDefinition[0];
  const properties = definition.function.parameters.properties;

  t.truthy(properties.userMessage);
  t.is(properties.userMessage.type, 'string');
  t.truthy(properties.icon);
  t.is(properties.icon.type, 'string');
  t.deepEqual(definition.function.parameters.required, ['query']);
});

test('WorkspaceSSH exposes optional icon override alongside userMessage', (t) => {
  const definition = workspaceSshTool.toolDefinition;
  const properties = definition.function.parameters.properties;

  t.truthy(properties.userMessage);
  t.is(properties.userMessage.type, 'string');
  t.truthy(properties.icon);
  t.is(properties.icon.type, 'string');
  t.deepEqual(definition.function.parameters.required, ['command', 'userMessage']);
});
