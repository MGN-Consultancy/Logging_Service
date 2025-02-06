//Version 1.0.3 please change the code below to match the current version as this is used to determine updates
// Notes

// Required modules
const nodeHttps = require('https');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const Registry = require('winreg');
const readline = require('readline');
const { EventLogger } = require('node-windows');
const mssql = require('mssql');

// Create an event logger instance
const eventLogger = new EventLogger('Azure Audit Service');

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
const currentVersion = "1.0.3"; // Ensure your current executable is named "audit_service_1.0.0.exe"
const remoteVersionUrl = "https://raw.githubusercontent.com/nigelwebsterMGN/logging_service/main/version.txt";
const remoteExeUrl = "https://raw.githubusercontent.com/nigelwebsterMGN/logging_service/main/audit_service_1.0.0.exe";

// Define the base directory for storing files and logs
const baseDir = 'C:\\program files\\Logging_Service';

// Ensure the base directory exists
if (!fs.existsSync(baseDir)) {
  fs.mkdirSync(baseDir, { recursive: true });
  logInfo(`Created base directory: ${baseDir}`);
}

// Define the service name and path to NSSM
const serviceName = "AuditLoggingService";
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

      // Define the new executable filename (e.g. audit_service_1.0.1.exe)
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
// Registry & SQL Functions
// ------------------------

// Reads a value from the specified registry key path and name.
function readRegistryValue(hive, keyPath, name) {
  return new Promise((resolve, reject) => {
    const regKey = new Registry({ hive: hive, key: keyPath });
    regKey.get(name, (err, item) => {
      if (err || !item) {
        reject(new Error(`Registry value '${name}' not found`));
      } else {
        resolve(item.value);
      }
    });
  });
}

// Updates a registry value.
function setRegistryValue(hive, keyPath, name, value) {
  return new Promise((resolve, reject) => {
    const regKey = new Registry({ hive: hive, key: keyPath });
    regKey.set(name, Registry.REG_SZ, value, err => {
      if (err) reject(err);
      else resolve();
    });
  });
}

// Updated Registry & SQL Functions

async function loadSqlConfig() {
  const hive = Registry.HKLM;
  const keyPath = '\\SOFTWARE\\AuditService';
  try {
    const SQLServer = await readRegistryValue(hive, keyPath, "SQLServer");
    const SQLUser = await readRegistryValue(hive, keyPath, "SQLUser");
    const SQLPass = await readRegistryValue(hive, keyPath, "SQLPass");
    const client_id = await readRegistryValue(hive, keyPath, "client_id");
    const DB_NAME = await readRegistryValue(hive, keyPath, "DB_NAME");
    return { SQLServer, SQLUser, SQLPass, client_id, DB_NAME };
  } catch (err) {
    throw new Error("Failed to load SQL configuration from registry: " + err.message);
  }
}


function createSqlConfig({ SQLServer, SQLUser, SQLPass }) {

  return {
    server: SQLServer,
    user: SQLUser,
    password: SQLPass, 
    options: {
      encrypt: true
    }
  };
}

// Queries the SQL server for allowed event IDs for the given client.
async function fetchEventIDsFromSQL(client_id, sqlConfig) {
  try {
    await mssql.connect(sqlConfig);
    const request = new mssql.Request();
    request.input('clientID', mssql.NVarChar, client_id);
    const result = await request.query(`
      SELECT STRING_AGG(CAST(e.event_id AS NVARCHAR(50)), ',') AS eventIDs
      FROM event_ids e
      INNER JOIN event_ids_client_relationship r ON e.event_id = r.event_id
      WHERE r.client_id = @clientID
    `);
    mssql.close();
    if (result.recordset.length && result.recordset[0].eventIDs) {
      return result.recordset[0].eventIDs;
    }
    return "";
  } catch (err) {
    mssql.close();
    throw new Error("SQL query error: " + err.message);
  }
}

// Updates the registry with the latest event IDs.
async function updateRegistryEventIDs(eventIDs) {
  try {
    await setRegistryValue(Registry.HKLM, '\\SOFTWARE\\AuditService', "event_ids", eventIDs);
    logInfo(`Updated registry with event IDs: ${eventIDs}`);
  } catch (err) {
    logError("Failed to update registry event IDs: " + err.message);
  }
}

// ------------------------
// Event Log Scraping & Caching
// ------------------------

const cacheFile = path.join(baseDir, "cached_events.json");

// Loads any cached events from disk.
function loadCachedEvents() {
  try {
    if (fs.existsSync(cacheFile)) {
      const data = fs.readFileSync(cacheFile, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    logError("Error loading cached events: " + err.message);
  }
  return [];
}

// Saves cached events to disk.
function saveCachedEvents(events) {
  try {
    fs.writeFileSync(cacheFile, JSON.stringify(events, null, 2), 'utf8');
  } catch (err) {
    logError("Error saving cached events: " + err.message);
  }
}

// Simulated function to scrape Windows event logs for provided event IDs.
// In a real implementation, you might call "wevtutil" or a specialized module.
async function scrapeEventLogs(eventIDs, lastScrapedTime) {
  // For illustration, assume function returns an array of event objects.
  // Each event has properties: event_id, event_name, event_username, event_ip,
  // event_ext_ip, event_type, event_description, event_timestamp.
  logInfo(`Scraping event logs for Event IDs: ${eventIDs}`);
  // ...Replace with real log scraping logic...
  // Dummy event example:
  return [{
    client_id: null, // will be set later
    hostname: require('os').hostname(),
    event_id: "1001",
    event_name: "Test Event",
    event_username: "user1",
    event_ip: "192.168.1.10",
    event_ext_ip: "8.8.8.8",
    event_type: "Information",
    event_description: "This is a test event from the event log.",
    event_timestamp: new Date().toISOString(),
    uploaded_timestamp: null
  }];
}

// Uploads events to the SQL table local_audit_logs.
async function uploadEventsToSQL(client_id, sqlConfig, events) {
  if (!events.length) return;
  try {
    await mssql.connect(sqlConfig);
    const transaction = new mssql.Transaction();
    await transaction.begin();
    const request = new mssql.Request(transaction);
    for (const ev of events) {
      // Ensure each event contains client_id and hostname etc.
      ev.client_id = client_id;
      ev.uploaded_timestamp = new Date();
      await request.query(`
        INSERT INTO local_audit_logs (client_id, hostname, event_id, event_name, event_username, event_ip, event_ext_ip, event_type, event_description, event_timestamp, uploaded_timestamp)
        VALUES (
          '${ev.client_id}', '${ev.hostname}', '${ev.event_id}', '${ev.event_name}', '${ev.event_username}', '${ev.event_ip}', '${ev.event_ext_ip}', '${ev.event_type}', '${ev.event_description}', '${ev.event_timestamp}', '${ev.uploaded_timestamp}'
        )
      `);
    }
    await transaction.commit();
    mssql.close();
    logInfo(`Uploaded ${events.length} events to SQL.`);
    return true;
  } catch (err) {
    mssql.close();
    logError("Error uploading events to SQL: " + err.message);
    return false;
  }
}

// ------------------------
// Main Functionality
// ------------------------
(async () => {
  await checkForUpdate();

  let sqlConfig, client_id, allowedEventIDs;
  try {
    // Read SQL connection parameters and client_id from registry.
    const sqlSettings = await loadSqlConfig();
    client_id = sqlSettings.client_id;
    sqlConfig = createSqlConfig(sqlSettings);

    // Attempt to fetch allowed event IDs from SQL.
    allowedEventIDs = await fetchEventIDsFromSQL(client_id, sqlConfig);
    // Update registry with the latest event IDs.
    await updateRegistryEventIDs(allowedEventIDs);
    logInfo(`Allowed Event IDs: ${allowedEventIDs}`);
  } catch (err) {
    logError("Error obtaining event IDs from SQL: " + err.message);
    // If SQL connection failed, attempt to load last known event IDs from registry.
    try {
      allowedEventIDs = await readRegistryValue(Registry.HKLM, '\\SOFTWARE\\AuditService', "event_ids");
      logInfo(`Using cached event IDs: ${allowedEventIDs}`);
    } catch (regErr) {
      logError("No cached event IDs available. Exiting service startup.");
      process.exit(1);
    }
  }

  // Log startup to the event log.
  logInfo("Service started. Beginning event log scraping...");

  let lastScrapedTime = new Date().toISOString();
  let cachedEvents = loadCachedEvents();

  // Function to process event scraping and SQL upload.
  async function processEvents() {
    try {
      let events = await scrapeEventLogs(allowedEventIDs, lastScrapedTime);
      // Update last scraped time.
      lastScrapedTime = new Date().toISOString();
      // Merge newly scraped events with any cached events.
      events = cachedEvents.concat(events);
      // Remove potential duplicates (you can improve the logic using event IDs/timestamps).
      const uniqueEvents = Array.from(new Map(events.map(ev => [ev.event_timestamp + ev.event_id, ev])).values());
      // Attempt upload to SQL.
      const uploadSuccess = await uploadEventsToSQL(client_id, sqlConfig, uniqueEvents);
      if (uploadSuccess) {
        // Clear cache if uploaded successfully.
        cachedEvents = [];
        saveCachedEvents(cachedEvents);
      } else {
        // Failed to upload; cache the events.
        cachedEvents = uniqueEvents;
        saveCachedEvents(cachedEvents);
      }
    } catch (err) {
      logError("Error during event processing: " + err.message);
    }
  }

  // Attempt uploading any previously cached events on startup.
  if (cachedEvents.length) {
    logInfo("Attempting to upload cached events...");
    const uploadSuccess = await uploadEventsToSQL(client_id, sqlConfig, cachedEvents);
    if (uploadSuccess) {
      cachedEvents = [];
      saveCachedEvents(cachedEvents);
    }
  }

  // Set an interval to run event scraping every 5 minutes.
  setInterval(processEvents, 5 * 60 * 1000);

  // Handle termination signals gracefully.
  process.on('SIGTERM', () => {
    logInfo('Received SIGTERM, shutting down gracefully...');
    process.exit(0);
  });

})();
