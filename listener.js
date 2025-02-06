//Version 1.0.3 please change the code below to match the current version as this is used to determine updates
// Notes

// Required modules
const nodeHttps = require('https');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const Registry = require('winreg');
const readline = require('readline');
const https = require('hyco-https');
const { EventLogger } = require('node-windows');

// Create an event logger instance
const eventLogger = new EventLogger('Azure Relay Listener Service');

// Helper logging functions – these log to both the console and the Windows Event Log.
function logInfo(message) {
  console.log(message);
  eventLogger.info(message);
}

function logError(message) {
  console.error(message);
  eventLogger.error(message);
}

// Versioning and self-update configuration using your repository URLs
const currentVersion = "1.0.3"; // Ensure your current executable is named "listener_1.0.0.exe"
const remoteVersionUrl = "https://raw.githubusercontent.com/nigelwebsterMGN/iam_agent/main/version.txt";
const remoteExeUrl = "https://raw.githubusercontent.com/nigelwebsterMGN/iam_agent/main/listener_1.0.0.exe";

// Define the base directory for storing files and logs
const baseDir = 'C:\\program files\\iam_agent';

// Ensure the base directory exists
if (!fs.existsSync(baseDir)) {
  fs.mkdirSync(baseDir, { recursive: true });
  logInfo(`Created base directory: ${baseDir}`);
}

// Define the service name and path to NSSM
const serviceName = "AzureRelayListener";
const nssmPath = "C:\\nssm\\win64\\nssm.exe";

// ------------------------
// Update Functions
// ------------------------

// Fetch plain text from a remote URL
function fetchRemoteText(url) {
  return new Promise((resolve, reject) => {
    nodeHttps.get(url, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => { resolve(data.trim()); });
    }).on('error', err => { reject(err); });
  });
}

// Compare semantic version strings (e.g. "1.0.0")
function isVersionNewer(remote, current) {
  const remoteParts = remote.split('.').map(Number);
  const currentParts = current.split('.').map(Number);
  for (let i = 0; i < Math.max(remoteParts.length, currentParts.length); i++) {
    const r = remoteParts[i] || 0;
    const c = currentParts[i] || 0;
    if (r > c) return true;
    if (r < c) return false;
  }
  return false;
}

// Download a file from a URL to a destination
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    nodeHttps.get(url, response => {
      if (response.statusCode !== 200) {
        return reject(new Error(`Failed to get '${url}' (Status Code: ${response.statusCode})`));
      }
      response.pipe(file);
      file.on('finish', () => {
        file.close(resolve);
      });
    }).on('error', err => {
      fs.unlink(dest, () => {}); // Delete the file asynchronously on error
      reject(err);
    });
  });
}

// New update mechanism using versioned filenames and a temporary file
async function checkForUpdate() {
  try {
    const remoteVersion = await fetchRemoteText(remoteVersionUrl);
    logInfo(`Remote version: ${remoteVersion}`);
    logInfo(`Current version: ${currentVersion}`);
    if (isVersionNewer(remoteVersion, currentVersion)) {
      logInfo("A newer version is available. Initiating update...");

      // Define the new executable filename (e.g. listener_1.0.1.exe)
      const newExeName = `listener_${remoteVersion}.exe`;
      const newExePath = path.join(baseDir, newExeName);
      const tempExePath = newExePath + ".tmp";

      // Download the new executable to a temporary file first
      await downloadFile(remoteExeUrl, tempExePath);
      logInfo(`Downloaded new version to temporary file ${tempExePath}`);

      // Rename the temporary file to the final versioned filename
      try {
        fs.renameSync(tempExePath, newExePath);
        logInfo(`Renamed temporary file to ${newExePath}`);
      } catch (renameErr) {
        logError(`Error renaming file: ${renameErr.message}`);
        // Optionally, clean up the temporary file if rename fails
        try { fs.unlinkSync(tempExePath); } catch (e) { }
        return;
      }

      // Update the service configuration to point to the new executable using NSSM
      const updateCmd = `"${nssmPath}" set "${serviceName}" Application "${newExePath}"`;
      logInfo(`Updating service configuration: ${updateCmd}`);
      exec(updateCmd, (err, stdout, stderr) => {
        if (err) {
          logError(`Error updating service configuration: ${err.message}`);
          return;
        }
        logInfo("Service configuration updated.");

        // Restart the service using NSSM
        const restartCmd = `"${nssmPath}" restart "${serviceName}"`;
        logInfo(`Restarting service with command: ${restartCmd}`);
        exec(restartCmd, (err2, stdout2, stderr2) => {
          if (err2) {
            logError(`Error restarting service: ${err2.message}`);
            return;
          }
          logInfo("Service restarted successfully.");
          // Exit so that the new version takes over when the service restarts
          process.exit(0);
        });
      });
    } else {
      logInfo("No update necessary.");
    }
  } catch (err) {
    logError("Update check failed: " + err.message);
  }
}


// ------------------------
// Registry and User Input Functions
// ------------------------

// Read a registry value with enhanced error handling
function readRegistryValue(key, name) {
  return new Promise((resolve, reject) => {
    key.get(name, (err, item) => {
      if (err || !item) {
        reject(new Error(`Registry value '${name}' not found`));
      } else {
        resolve(item.value);
      }
    });
  });
}

// Prompt the user for input
function promptUser(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise((resolve) => rl.question(query, (answer) => {
    rl.close();
    resolve(answer);
  }));
}

// Check and set registry values – prompts if not found, but exits in service mode
async function checkAndSetRegistryValues() {
  const regKey = new Registry({
    hive: Registry.HKLM,
    key: '\\SOFTWARE\\iam_automation'
  });
  const keys = ['ns', 'path', 'keyrule', 'primarykey', 'secondarykey'];
  const values = {};
  
  for (const key of keys) {
    try {
      values[key] = await readRegistryValue(regKey, key);
    } catch (err) {
      if (process.argv.includes('--service')) {
        logError(`Missing registry key '${key}' and cannot prompt in service mode. Exiting.`);
        process.exit(1);
      } else {
        let input = await promptUser(`Enter value for ${key}${key === 'keyrule' ? " (default is 'default')" : ""}: `);
        if (key === 'keyrule' && (!input || input.trim() === "")) {
          input = "default";
        }
        values[key] = input;
      }
    }
  }
  return values;
}

// Determine if running as a service (via command-line flag)
function isRunningAsService() {
  return process.argv.includes('--service');
}

// ------------------------
// Main Functionality
// ------------------------

(async () => {
  // Check for updates before initialisation
  await checkForUpdate();

  let server;
  try {
    const config = await checkAndSetRegistryValues();
    logInfo('Registry values retrieved: ' + JSON.stringify(config));

    // Generate Relay URI and Token
    const uri = https.createRelayListenUri(config.ns, config.path);
    logInfo(`Relay URI: ${uri}`);

    const uriForToken = `https://${config.ns}/${config.path}`;
    let token = https.createRelayToken(uriForToken, config.keyrule, config.primarykey);
    logInfo(`Generated Token: ${token}`);

    // Refresh the token every 30 minutes to prevent staleness
    setInterval(() => {
      token = https.createRelayToken(uriForToken, config.keyrule, config.primarykey);
      logInfo(`Token refreshed: ${token}`);
    }, 30 * 60 * 1000);

    // Create the Relay listener
    server = https.createRelayedServer(
      {
        server: uri,
        token: () => token,
      },
      (req, res) => {
        logInfo(`Request received: ${req.method} ${req.url}`);
        let body = '';
        req.on('data', (chunk) => {
          logInfo(`Received data chunk: ${chunk}`);
          body += chunk;
        });
        req.on('end', () => {
          logInfo(`Full request body: ${body}`);
          try {
            const payload = JSON.parse(body);
            const command = payload.command;
            logInfo(`Original PowerShell command: ${command}`);

            // Encode the command: UTF-16LE then Base64
            const encodedCommand = Buffer.from(command, 'utf16le').toString('base64');
            logInfo(`Encoded Command: ${encodedCommand}`);

            // Execute the command in PowerShell using -EncodedCommand mode
            exec(`powershell.exe -NoProfile -NonInteractive -EncodedCommand "${encodedCommand}"`, (error, stdout, stderr) => {
              logInfo(`Executing PowerShell command: ${command}`);
              if (error) {
                logError(`Execution error: ${error.message}`);
                res.statusCode = 500;
                res.end(JSON.stringify({ error: error.message }));
                return;
              }
              if (stderr) {
                logError(`PowerShell error: ${stderr}`);
                res.statusCode = 500;
                res.end(JSON.stringify({ error: stderr }));
                return;
              }
              logInfo(`Command output: ${stdout}`);
              res.statusCode = 200;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ output: stdout }));
            });
          } catch (err) {
            logError(`Error parsing request: ${err.message}`);
            res.statusCode = 400;
            res.end(JSON.stringify({ error: 'Invalid request payload' }));
          }
        });
      }
    );

    // Start listening on the Azure Relay
    server.listen((err) => {
      if (err) {
        logError(`Error starting the server: ${err.message}`);
        return;
      }
      logInfo(`Server is listening on Azure Relay: ${uri}`);
    });

    // Additional event handlers
    server.on('listening', () => logInfo('Listener is now listening.'));
    server.on('connection', () => logInfo('New connection established.'));
    server.on('error', (err) => logError(`Listener error: ${err.message}`));

    // Handle termination signals when running as a service
    if (isRunningAsService()) {
      logInfo('Running as a service.');
      process.on('SIGTERM', () => {
        logInfo('Received SIGTERM, shutting down gracefully...');
        if (server) {
          server.close(() => {
            logInfo('Server closed.');
            process.exit(0);
          });
        }
      });
    } else {
      logInfo('Running as an application.');
    }
  } catch (err) {
    logError('Error during initialisation: ' + err.message);
    if (server) {
      server.close(() => {
        logInfo('Server closed due to initialisation error.');
      });
    }
    process.exit(1);
  }
})();
