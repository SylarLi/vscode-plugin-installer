// Import necessary modules
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const https = require('https');
const os = require('os');
const zlib = require('zlib');

// Activation function, plugin entry
function activate(context) {
    // Register command
    let disposable = vscode.commands.registerCommand('vscode-plugin-installer.installPlugin', async function () {
        // Get the plugin marketplace link from user input
        const input = await vscode.window.showInputBox({
            prompt: 'Please enter VS Code marketplace link or plugin ID',
            placeHolder: 'Example: https://marketplace.visualstudio.com/items?itemName=xxx or publisher.pluginName'
        });

        if (!input) {
            vscode.window.showErrorMessage('Please enter a valid marketplace link or plugin ID');
            return;
        }

        let pluginId;
        // Check if input is a URL
        try {
            const url = new URL(input);
            pluginId = url.searchParams.get('itemName');
        } catch (e) {
            // If not a URL, use input as plugin ID directly
            pluginId = input;
        }

        // Validate plugin ID format
        if (!pluginId || !/^.+\..+$/.test(pluginId)) {
            throw new Error('Invalid plugin ID format. Expected format: publisher.pluginName');
        }

        const extension = await vscode.extensions.getExtension(pluginId);
        if (extension) {
            throw new Error(`Plugin ${pluginId} is already installed!`);
        }

        try {
            // Download and install the plugin
            vscode.window.showInformationMessage(`Installing plugin: ${pluginId}...`);
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Installing ${pluginId}`,
                cancellable: false
            }, async (progress) => {
                progress.report({ message: 'Starting installation...' });
                await installPlugin(pluginId);
                progress.report({ message: 'Finishing installation...', increment: 100 });
            });
            vscode.window.showInformationMessage(`Plugin ${pluginId} installed successfully!`);
        } catch (error) {
            vscode.window.showErrorMessage(`Plugin installation failed: ${error.message}`);
        }
    });

    context.subscriptions.push(disposable);
}

// Get plugin version information
async function getPluginVersion(pluginId) {
    const apiUrl = `https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery`;
    const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json;api-version=3.0-preview.1'
        },
        body: JSON.stringify({
            filters: [{
                criteria: [
                    { filterType: 7, value: pluginId }
                ]
            }],
            flags: 914
        })
    });
    const data = await response.json();
    return data.results[0].extensions[0].versions[0];
}

// Plugin installation function
async function installPlugin(pluginId) {
    const tempDir = path.join(os.tmpdir(), 'vscode-plugins');
    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir);
    }

    const vsixPath = path.join(tempDir, `${pluginId}.vsix`);

    // Download the VSIX file
    try {
        // Get latest version number
        const versionInfo = await getPluginVersion(pluginId);
        await new Promise((resolve, reject) => {
            const file = fs.createWriteStream(vsixPath);
            file.on('error', err => {
                fs.unlink(vsixPath, () => { });
                reject(new Error(`Failed to write plugin file: ${err.message}`));
            });
            const url = `https://marketplace.visualstudio.com/_apis/public/gallery/publishers/${pluginId.split('.')[0]}/vsextensions/${pluginId.split('.')[1]}/${versionInfo.version}/vspackage`;
            console.log(`Downloading plugin from: ${url}`);
            console.log('Saving plugin to: ' + vsixPath);
            https.get(url, response => {
                if (response.statusCode !== 200) {
                    fs.unlink(vsixPath, () => { });
                    reject(new Error(`Failed to download plugin: HTTP ${response.statusCode}`));
                    return;
                }
                let output;
                if (response.headers['content-encoding'] === 'gzip') {
                    output = response.pipe(zlib.createGunzip());
                } else {
                    output = response;
                }
                output.pipe(file);
                file.on('finish', () => {
                    file.close(resolve);
                });
            }).on('error', err => {
                fs.unlink(vsixPath, () => { });
                reject(new Error(`Failed to download plugin: ${err.message}`));
            });
        });
    } catch (error) {
        throw new Error(`Plugin download failed: ${error.message}`);
    }

    try {
        // Install the plugin
        console.log(`Installing plugin from: ${vsixPath}`);
        await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(vsixPath));
    } catch (error) {
        throw new Error(`Plugin installation failed: ${error.message}`);
    }
    finally {
        // Clean up
        fs.unlinkSync(vsixPath);
    }

    // 轮询等待插件安装完成
    const maxAttempts = 3;
    let attempts = 0;
    let installedExtension;
    while (attempts < maxAttempts) {
        installedExtension = await vscode.extensions.getExtension(pluginId);
        if (installedExtension) {
            break;
        }
        await new Promise(resolve => setTimeout(resolve, 1000)); // 等待 1 秒
        attempts++;
    }

    if (!installedExtension) {
        throw new Error(`Failed to install plugin: ${pluginId}`);
    }

    // Check and install dependencies
    const packageJSON = installedExtension.packageJSON;
    if (packageJSON.extensionDependencies) {
        for (const dependency of packageJSON.extensionDependencies) {
            const depExtension = vscode.extensions.getExtension(dependency);
            if (!depExtension) {
                vscode.window.showInformationMessage(`Installing dependency: ${dependency}...`);
                await installPlugin(dependency);
            }
        }
    }
}

// Export activation function
module.exports = {
    activate
};