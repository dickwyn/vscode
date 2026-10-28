/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { TERMINAL_AUTO_APPROVE_ENABLED_SETTING_ID } from '../../../../../../platform/agentHost/common/agentHostSchema.js';
import type { IConfigurationChangeEvent, IConfigurationService, IConfigurationValue } from '../../../../../../platform/configuration/common/configuration.js';
import { AgentNetworkDomainSettingId } from '../../../../../../platform/networkFilter/common/settings.js';
import { ManagedSettingsData, NullManagedSettingsService } from '../../../../../../platform/policy/common/copilotManagedSettings.js';
import { getSemanticSearchManagedPolicyState, isSemanticSearchDisabledByManagedPolicy, whenSemanticSearchManagedPolicyChanges } from '../../../browser/agentSessions/agentHost/semanticSearchManagedPolicy.js';

suite('SemanticSearchManagedPolicy', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	function services(store: DisposableStore, managedSettings: ManagedSettingsData, configuration: Record<string, IConfigurationValue<unknown>> = {}) {
		const onDidChangeManagedSettings = store.add(new Emitter<void>());
		const onDidChangeConfiguration = store.add(new Emitter<IConfigurationChangeEvent>());
		const managedSettingsService = new class extends NullManagedSettingsService {
			override readonly onDidChangeManagedSettings = onDidChangeManagedSettings.event;
			override getManagedSettingValue(key: string) { return managedSettings[key]; }
		}();
		const configurationService = {
			inspect: <T>(key: string) => (configuration[key] ?? {}) as IConfigurationValue<T>,
			onDidChangeConfiguration: onDidChangeConfiguration.event,
		} as Partial<IConfigurationService> as IConfigurationService;
		return { managedSettingsService, configurationService, onDidChangeManagedSettings };
	}

	function state(managedSettings: ManagedSettingsData, configuration: Record<string, IConfigurationValue<unknown>> = {}) {
		const store = new DisposableStore();
		try {
			const { managedSettingsService, configurationService } = services(store, managedSettings, configuration);
			return getSemanticSearchManagedPolicyState(managedSettingsService, configurationService);
		} finally {
			store.dispose();
		}
	}

	test('disables semantic search for managed rules everywhere and for bridged read restrictions only on hosts that receive them', () => {
		const cases = {
			none: state({}),
			emptyRuleLists: state({ 'permissions.deny': '[]', 'permissions.ask': '[]' }),
			modeLockOnly: state({ 'permissions.disableBypassPermissionsMode': 'disable' }),
			managedRule: state({ 'permissions.deny': '["Read(/denied/**)"]' }),
			// Bridged rules are non-activating, so a bridged shell ask leaves reads unrestricted.
			bridgedShellPolicy: state({}, { [TERMINAL_AUTO_APPROVE_ENABLED_SETTING_ID]: { defaultValue: true, policyValue: false } }),
			personalPreferenceOnly: state({}, { [TERMINAL_AUTO_APPROVE_ENABLED_SETTING_ID]: { defaultValue: true, userValue: false } }),
			// A personal network filter with no domain lists bridges `deny: ['Domain']`.
			personalNetworkFilter: state({}, { [AgentNetworkDomainSettingId.NetworkFilter]: { defaultValue: false, userValue: true } }),
		};
		assert.deepStrictEqual(Object.fromEntries(Object.entries(cases).map(([name, value]) => [name, {
			state: value,
			localHost: isSemanticSearchDisabledByManagedPolicy(value, true),
			remoteHost: isSemanticSearchDisabledByManagedPolicy(value, false),
		}])), {
			none: { state: { managedRules: false, bridgedReadRules: false }, localHost: false, remoteHost: false },
			emptyRuleLists: { state: { managedRules: false, bridgedReadRules: false }, localHost: false, remoteHost: false },
			modeLockOnly: { state: { managedRules: false, bridgedReadRules: false }, localHost: false, remoteHost: false },
			managedRule: { state: { managedRules: true, bridgedReadRules: false }, localHost: true, remoteHost: true },
			bridgedShellPolicy: { state: { managedRules: false, bridgedReadRules: false }, localHost: false, remoteHost: false },
			personalPreferenceOnly: { state: { managedRules: false, bridgedReadRules: false }, localHost: false, remoteHost: false },
			personalNetworkFilter: { state: { managedRules: false, bridgedReadRules: false }, localHost: false, remoteHost: false },
		});
		assert.deepStrictEqual([
			isSemanticSearchDisabledByManagedPolicy({ managedRules: false, bridgedReadRules: true }, true),
			isSemanticSearchDisabledByManagedPolicy({ managedRules: false, bridgedReadRules: true }, false),
		], [true, false]);
	});

	test('reports a policy change as soon as it differs from the last known value', async () => {
		const store = disposables.add(new DisposableStore());
		const managedSettings: Record<string, string> = {};
		const { managedSettingsService, configurationService, onDidChangeManagedSettings } = services(store, managedSettings);

		const initial = await whenSemanticSearchManagedPolicyChanges(managedSettingsService, configurationService, undefined);
		const added = whenSemanticSearchManagedPolicyChanges(managedSettingsService, configurationService, false);
		// An unrelated managed settings change does not resolve the wait.
		managedSettings['permissions.disableBypassPermissionsMode'] = 'disable';
		onDidChangeManagedSettings.fire();
		managedSettings['permissions.ask'] = '["Shell"]';
		onDidChangeManagedSettings.fire();
		const afterAdd = await added;
		const removed = whenSemanticSearchManagedPolicyChanges(managedSettingsService, configurationService, true);
		delete managedSettings['permissions.ask'];
		onDidChangeManagedSettings.fire();

		assert.deepStrictEqual({ initial, afterAdd, afterRemove: await removed }, { initial: false, afterAdd: true, afterRemove: false });
	});
});
