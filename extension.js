// Import necessary modules
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const https = require('https');
const os = require('os');
const zlib = require('zlib');
const jszip = require('jszip');

var vsixs = [];

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
            vscode.window.showErrorMessage(`Plugin ${pluginId} is already installed!`);
            return;
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
                await downloadPlugin(pluginId);
                await setupPlugins();
                progress.report({ message: 'Finishing installation...', increment: 100 });
            });
            vscode.window.showInformationMessage(`Plugin ${pluginId} installed successfully!`);
        } catch (error) {
            vscode.window.showErrorMessage(`Plugin installation failed: ${error.message}`);
        }
    });

    context.subscriptions.push(disposable);
}

// Get plugin information
async function getLatestVersion(pluginId) {
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
            pageNumber: 1,
            pageSize: 100,
            flags: 0x1 | 0x10
        })
    });
    const data = await response.json();
    const firstNonePreReleaseVersion = data.results[0].extensions[0].versions.find(v => !(v.properties?.find(p => p.key === 'Microsoft.VisualStudio.Code.PreRelease')?.value === 'true'));
    return firstNonePreReleaseVersion.version;
}

// Plugin installation function
async function downloadPlugin(pluginId) {
    if (vsixs.includes(pluginId)) {
        const index = vsixs.indexOf(pluginId);
        vsixs.splice(index, 1);
        vsixs.push(pluginId);
        return;
    }

    const extension = await vscode.extensions.getExtension(pluginId);
    if (extension) {
        return;
    }

    const tempDir = path.join(os.tmpdir(), 'vscode-plugins');
    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir);
    }

    var version = await getLatestVersion(pluginId);
    const vsixPath = path.join(tempDir, `${pluginId}_${version}.vsix`);

    try {
        await new Promise((resolve, reject) => {
            const file = fs.createWriteStream(vsixPath);
            file.on('error', err => {
                fs.unlink(vsixPath, () => { });
                reject(new Error(`Failed to write plugin file: ${err.message}`));
            });
            const url = `https://marketplace.visualstudio.com/_apis/public/gallery/publishers/${pluginId.split('.')[0]}/vsextensions/${pluginId.split('.')[1]}/${version}/vspackage`;
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

    vsixs.push(vsixPath);

    const dependencies = await getPluginDependencies(vsixPath);
    for (const dependency of dependencies) {
        await downloadPlugin(dependency);
    }
}

async function getPluginDependencies(vsixPath) {
    const dependencies = [];
    const vsixBuffer = fs.readFileSync(vsixPath);
    const vsixZip = new jszip();
    await vsixZip.loadAsync(vsixBuffer);
    const manifestFile = vsixZip.file('extension/package.json');
    if (manifestFile) {
        const manifestContent = await manifestFile.async('string');
        const manifest = JSON.parse(manifestContent);
        if (manifest.extensionDependencies) {
            for (const key in manifest.extensionDependencies) {
                if (manifest.extensionDependencies.hasOwnProperty(key)) {
                    const dependency = manifest.extensionDependencies[key];
                    dependencies.push(dependency);
                }   
            }
        }
    }

    return dependencies;
}

async function setupPlugins() {
    try {
        for (const vsixPath of vsixs.reverse()) {
            // Install the plugin
            console.log(`Installing plugin from: ${vsixPath}`);
            await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(vsixPath));
        }
    } catch (error) {
        throw new Error(`Plugin installation failed: ${error.message}`);
    } finally {
        // for (const vsixPath of vsixs) {
        //     fs.unlinkSync(vsixPath);
        // }
    }
}

// Export activation function
module.exports = {
    activate
};