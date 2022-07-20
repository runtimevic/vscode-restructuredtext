/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { CommandManager } from './util/commandManager';
import * as commands from './commands/index';
import { RSTContentProvider } from './preview/previewContentProvider';
import { RSTPreviewManager } from './preview/previewManager';
import { Logger } from './util/logger';
import { Python } from './util/python';
import { RSTEngine } from './preview/rstEngine';
import { ExtensionContentSecurityPolicyArbiter, PreviewSecuritySelector } from './util/security';

import { Configuration } from './util/configuration';
import RstTransformerStatus from './preview/statusBar';
import * as RstLanguageServer from './language-server/extension';
import * as EditorFeatures from './editor/extension';
import * as LinterFeatures from './linter/extension';
import { setGlobalState, setWorkspaceState } from './util/stateUtils';
import { initConfig } from './util/config';
import { Commands } from './constants';

let extensionPath = '';

export function getExtensionPath(): string {
    return extensionPath;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {

    setGlobalState(context.globalState);
    setWorkspaceState(context.workspaceState);

    const channel = vscode.window.createOutputChannel('reStructuredText');

    await initConfig(context);

    extensionPath = context.extensionPath;
    await EditorFeatures.activate(context);

    const logger = new Logger(channel);
    logger.log('Please visit https://docs.restructuredtext.net to learn how to configure the extension.');

    const conflicting = Configuration.getConflictingExtensions();
    for (const element of conflicting) {
        const found = vscode.extensions.getExtension(element);
        if (found) {
            const message = `Found conflicting extension ${found.packageJSON.displayName}(${element}). Do you want to uninstall it now?`;
            logger.log(`found ${element}`);
            const choice = await vscode.window.showErrorMessage(message, "Yes", "No");
            if (choice === 'Yes') {
                await vscode.commands.executeCommand(Commands.OPEN_EXTENSION, element);
                await vscode.commands.executeCommand(Commands.UNINSTALL_EXTENSION, element);
                await vscode.commands.executeCommand(Commands.RELOAD_WINDOW);

            } else {
                vscode.window.showWarningMessage('Since conflicting extension is not uninstalled, extension activation ends now.');
                return;
            }
        }
    }

    const msPythonName = 'ms-python.python';
    // guide the users to install Microsoft Python extension.
    const msPython = vscode.extensions.getExtension(msPythonName);
    if (!msPython && !Configuration.getPythonRecommendationDisabled()) {
        const message = 'It is recommended to install Microsoft Python extension. Do you want to install it now?';
        const choice = await vscode.window.showInformationMessage(message, 'Install', 'Not now', 'Do not show again');
        if (choice === 'Install') {
            logger.log('Started to install ms-python...');
            await vscode.commands.executeCommand(Commands.OPEN_EXTENSION, msPythonName);
            await vscode.commands.executeCommand(Commands.INSTALL_EXTENSION, msPythonName);
        } else if (choice === 'Do not show again') {
            logger.log('Disabled ms-python prompt.');
            await Configuration.setPythonRecommendationDisabled();
        }
    }

    const simpleRstName = 'trond-snekvik.simple-rst';
    const simpleRst = vscode.extensions.getExtension(simpleRstName);
    if (!simpleRst && !Configuration.getSyntaxHighlightingDisabled()) {
        const message = 'Syntax highlighting is now provided by Trond Snekvik\'s extension. Do you want to install it now?';
        const choice = await vscode.window.showInformationMessage(message, 'Install', 'Not now', 'Do not show again');
        if (choice === 'Install') {
            logger.log('Started to install simple-rst...');
            await vscode.commands.executeCommand(Commands.OPEN_EXTENSION, simpleRstName);
            await vscode.commands.executeCommand(Commands.INSTALL_EXTENSION, simpleRstName);
        } else if (choice === 'Do not show again') {
            logger.log('Disabled syntax highlighting.');
            await Configuration.setSyntaxHighlightingDisabled();
            vscode.window.showWarningMessage('Syntax highlighting is now disabled.');
        } else {
            vscode.window.showWarningMessage('No Syntax highlighting. Trond Snekvik\'s extension is not installed.');
        }
    }

    await logger.logPlatform();

    const python: Python = new Python(logger);
    await python.setup();

    await LinterFeatures.activate(context, python, logger);

    // Status bar to show the active rst->html transformer configuration
    const status = new RstTransformerStatus(python, logger);

    // Hook up the status bar to document change events
    context.subscriptions.push(
        vscode.commands.registerCommand('restructuredtext.resetStatus',
            status.reset, status),
    );

    vscode.window.onDidChangeActiveTextEditor(status.update, status, context.subscriptions);
    await status.update();

    // porting settings over
    const newSection = vscode.workspace.getConfiguration("esbonio");
    const oldSection = vscode.workspace.getConfiguration("restructuredtext");

    let buildDir = oldSection.get<string>('builtDocumentationPath');
    if (buildDir) {
        if (buildDir.endsWith("/html") || buildDir.endsWith("\\html")) {
            buildDir = buildDir.substring(0, buildDir.length - 5);
        }
        await newSection.update("sphinx.buildDir", buildDir);
        vscode.window.showWarningMessage('Setting "restructuredtext.builtDocumentationPath" is migrated to "esbonio.sphinx.buildDir". Please manually delete "restructuredtext.builtDocumentationPath" from your config file.');
    }

    const confDir = oldSection.get<string>('confPath');
    if (confDir) {
        await newSection.update("sphinx.confDir", confDir);
        vscode.window.showWarningMessage('Setting "restructuredtext.confPath" is migrated to "esbonio.sphinx.confDir". Please manually delete "restructuredtext.confPath" from your config file.');
    }

    const srcDir = oldSection.get<string>('sourcePath');
    if (srcDir) {
        await newSection.update("sphinx.srcDir", srcDir);
        vscode.window.showWarningMessage('Setting "restructuredtext.sourcePath" is migrated to "esbonio.sphinx.srcDir". Please manually delete "restructuredtext.sourcePath" from your config file.');
    }

    const lspChannel = vscode.window.createOutputChannel('Esbonio Language Server');
    const lspLogger = new Logger(lspChannel);
    // activate language services
    const esbonio = await RstLanguageServer.activate(context, lspChannel, lspLogger, python);

    if (!Configuration.getDocUtilDisabled() || !Configuration.getSphinxDisabled()) {

        const cspArbiter = new ExtensionContentSecurityPolicyArbiter(context.globalState, context.workspaceState);

        const engine: RSTEngine = new RSTEngine(python, logger, status, esbonio);

        const contentProvider = new RSTContentProvider(context, cspArbiter, engine, logger);
        const previewManager = new RSTPreviewManager(contentProvider, logger, esbonio);
        context.subscriptions.push(previewManager);

        const previewSecuritySelector = new PreviewSecuritySelector(cspArbiter, previewManager);

        const commandManager = new CommandManager();
        context.subscriptions.push(commandManager);
        commandManager.register(new commands.ShowPreviewCommand(previewManager, python));
        commandManager.register(new commands.ShowPreviewToSideCommand(previewManager, python));
        commandManager.register(new commands.ShowLockedPreviewToSideCommand(previewManager, python));
        commandManager.register(new commands.ShowSourceCommand(previewManager));
        commandManager.register(new commands.RefreshPreviewCommand(previewManager));
        commandManager.register(new commands.MoveCursorToPositionCommand());
        commandManager.register(new commands.ShowPreviewSecuritySelectorCommand(previewSecuritySelector, previewManager));
        commandManager.register(new commands.OpenDocumentLinkCommand());
        commandManager.register(new commands.ToggleLockCommand(previewManager));

        context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(() => {
            logger.updateConfiguration();
            previewManager.updateConfiguration();
        }));
    }
}
