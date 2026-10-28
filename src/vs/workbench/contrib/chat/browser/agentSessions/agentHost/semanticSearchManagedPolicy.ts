/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../../../base/common/event.js';
import { IObservable, observableFromEventOpts } from '../../../../../../base/common/observable.js';
import { hasManagedReadRestriction } from '../../../../../../platform/agentHost/common/agentHostManagedRules.js';
import { managedPermissionsConfigurationIds, resolveManagedSettingsPermissions } from '../../../../../../platform/agentHost/common/agentHostManagedSettings.js';
import { CommandsRegistry } from '../../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { hasManagedPermissionRules, IManagedSettingsService } from '../../../../../../platform/policy/common/copilotManagedSettings.js';

/** Internal command the Copilot extension queries to explain why semantic search is unavailable. */
export const IS_SEMANTIC_SEARCH_DISABLED_BY_MANAGED_POLICY_COMMAND_ID = '_chat.isSemanticSearchDisabledByManagedPolicy';

/**
 * Internal command that resolves with whether managed policy disables semantic
 * search once that differs from the caller's last known value, so the Copilot
 * extension can keep its status current without polling.
 */
export const WHEN_SEMANTIC_SEARCH_MANAGED_POLICY_CHANGES_COMMAND_ID = '_chat.whenSemanticSearchManagedPolicyChanges';

/** Which Copilot managed permission sources are active, as VS Code sees them. */
export interface ISemanticSearchManagedPolicyState {
	/** Managed permission rule lists delivered by native MDM, server, or file managed settings. */
	readonly managedRules: boolean;
	/**
	 * Whether the rules the bridge sends to a local Agent Host restrict reads.
	 * Bridged rules are non-activating, so only a bridged `Read` deny or ask rule
	 * affects semantic search; other bridged rules, including ones that personal
	 * settings produce, do not.
	 */
	readonly bridgedReadRules: boolean;
}

/**
 * Reads whether Copilot managed permissions disable semantic search. The Agent
 * Host withholds and denies semantic search while any enterprise managed
 * permission rule is active, because the runtime cannot match a query against
 * managed `Read` rules and the tool's own confirmation cannot guarantee a human
 * decision. This mirrors that decision for the rules VS Code can see; the host
 * remains authoritative.
 */
export function getSemanticSearchManagedPolicyState(managedSettingsService: IManagedSettingsService, configurationService: IConfigurationService): ISemanticSearchManagedPolicyState {
	const bridged = resolveManagedSettingsPermissions(configurationService);
	return {
		managedRules: hasManagedPermissionRules(managedSettingsService),
		bridgedReadRules: hasManagedReadRestriction(bridged),
	};
}

/** Whether semantic search is disabled for a session whose host does or does not receive bridged rules. */
export function isSemanticSearchDisabledByManagedPolicy(state: ISemanticSearchManagedPolicyState, receivesBridgedRules: boolean): boolean {
	return state.managedRules || (receivesBridgedRules && state.bridgedReadRules);
}

/** Fires when managed settings or a setting the bridge maps may have changed {@link getSemanticSearchManagedPolicyState}. */
function onDidChangeSemanticSearchManagedPolicyInputs(managedSettingsService: IManagedSettingsService, configurationService: IConfigurationService): Event<unknown> {
	return Event.any<unknown>(
		managedSettingsService.onDidChangeManagedSettings,
		Event.filter(configurationService.onDidChangeConfiguration, e => managedPermissionsConfigurationIds.some(id => e.affectsConfiguration(id))),
	);
}

/** Observes {@link getSemanticSearchManagedPolicyState} as managed settings and bridged policies change. */
export function observeSemanticSearchManagedPolicyState(owner: object, managedSettingsService: IManagedSettingsService, configurationService: IConfigurationService): IObservable<ISemanticSearchManagedPolicyState> {
	return observableFromEventOpts(
		{ owner, equalsFn: (a, b) => a.managedRules === b.managedRules && a.bridgedReadRules === b.bridgedReadRules },
		onDidChangeSemanticSearchManagedPolicyInputs(managedSettingsService, configurationService),
		() => getSemanticSearchManagedPolicyState(managedSettingsService, configurationService),
	);
}

/**
 * Resolves with whether managed policy disables semantic search in a local
 * window as soon as that differs from `lastKnown`.
 */
export function whenSemanticSearchManagedPolicyChanges(managedSettingsService: IManagedSettingsService, configurationService: IConfigurationService, lastKnown: boolean | undefined): Promise<boolean> {
	const read = () => isSemanticSearchDisabledByManagedPolicy(getSemanticSearchManagedPolicyState(managedSettingsService, configurationService), true);
	const current = read();
	if (current !== lastKnown) {
		return Promise.resolve(current);
	}
	return new Promise<boolean>(resolve => {
		const listener = onDidChangeSemanticSearchManagedPolicyInputs(managedSettingsService, configurationService)(() => {
			const next = read();
			if (next !== lastKnown) {
				listener.dispose();
				resolve(next);
			}
		});
	});
}

CommandsRegistry.registerCommand(IS_SEMANTIC_SEARCH_DISABLED_BY_MANAGED_POLICY_COMMAND_ID, accessor =>
	isSemanticSearchDisabledByManagedPolicy(getSemanticSearchManagedPolicyState(accessor.get(IManagedSettingsService), accessor.get(IConfigurationService)), true));

CommandsRegistry.registerCommand(WHEN_SEMANTIC_SEARCH_MANAGED_POLICY_CHANGES_COMMAND_ID, (accessor, lastKnown: unknown) =>
	whenSemanticSearchManagedPolicyChanges(accessor.get(IManagedSettingsService), accessor.get(IConfigurationService), typeof lastKnown === 'boolean' ? lastKnown : undefined));
