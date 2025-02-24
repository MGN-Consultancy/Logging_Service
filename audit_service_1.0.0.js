//Version 1.0.3 - Ensure your current executable is named "audit_service_1.0.3.exe"
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

// Add a flag to enable/disable logging to the Windows Event Log.
const enableEventLog = false; // Set to false to disable event log logging during development

// Create an event logger instance
const eventLogger = new EventLogger('Azure Audit Service');

// Helper logging functions – these log to both the console and the Windows Event Log.
function logInfo(message) {
  console.log(message);
  if (enableEventLog) eventLogger.info(message);
}

function logError(message) {
  console.error(message);
  if (enableEventLog) eventLogger.error(message);
}

// Versioning and self-update configuration using your repository URLs
const currentVersion = "1.0.3"; 
const remoteVersionUrl = "https://raw.githubusercontent.com/nigelwebsterMGN/logging_service/main/version.txt";
// Updated remoteExeUrl to reflect current version
const remoteExeUrl = "https://raw.githubusercontent.com/nigelwebsterMGN/logging_service/main/audit_service_1.0.3.exe";

// Replace hardcoded baseDir and its dependents with mutable globals
let baseDir = 'C:\\program files\\Logging_Service'; // default fallback
let logsDir; 
let lastScrapeFile;
let cacheFile;

// Modify loadSqlConfig to also load the installation path from registry
async function loadSqlConfig() {
  const hive = Registry.HKLM;
  const keyPath = '\\SOFTWARE\\auditservice';
  try {
    const SQLServer = await readRegistryValue(hive, keyPath, "SQLServer");
    const SQLUser = await readRegistryValue(hive, keyPath, "SQLUser");
    const SQLPass = await readRegistryValue(hive, keyPath, "SQLPass");
    const client_id = await readRegistryValue(hive, keyPath, "client_id");
    const DB_NAME = await readRegistryValue(hive, keyPath, "DB_NAME");
    const installPath = await readRegistryValue(hive, keyPath, "path");
    return { SQLServer, SQLUser, SQLPass, client_id, DB_NAME, installPath };
  } catch (err) {
    throw new Error("Failed to load SQL configuration from registry: " + err.message);
  }
}

// Define the service name and path to NSSM
const serviceName = "AuditLoggingService";
const nssmPath = "C:\\nssm\\win64\\nssm.exe";

// Function to get the last scrape time. If not found, set to 7 days ago.
function getLastScrapeTime() {
  let lastScrape;
  if (fs.existsSync(lastScrapeFile)) {
    lastScrape = fs.readFileSync(lastScrapeFile, 'utf8').trim();
    logInfo(`Last scrape timestamp found: ${lastScrape}`);
  } else {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    lastScrape = sevenDaysAgo;
    fs.writeFileSync(lastScrapeFile, lastScrape, 'utf8');
    logInfo(`No last scrape timestamp found. Performing initial scrape over the past 7 days: ${lastScrape}`);
  }
  return lastScrape;
}

// Function to update the last scrape time to the current timestamp.
function updateLastScrapeTime() {
  const currentTimestamp = new Date().toISOString();
  fs.writeFileSync(lastScrapeFile, currentTimestamp, 'utf8');
  logInfo(`Updated last scrape timestamp to: ${currentTimestamp}`);
}

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

      // Define the new executable filename using the audit_service prefix
      const newExeName = `audit_service_${remoteVersion}.exe`;
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

// Updated createSqlConfig to include DB_NAME
function createSqlConfig({ SQLServer, SQLUser, SQLPass, DB_NAME }) {
  return {
    server: SQLServer,
    user: SQLUser,
    password: SQLPass, 
    database: DB_NAME,
    options: {
      encrypt: true,
      trustServerCertificate: true,
    }
  };
}

// Updated fetchEventIDsFromSQL with fully qualified table names:
async function fetchEventIDsFromSQL(client_id, sqlConfig) {
  try {
    logInfo("Connecting to SQL with config: " + JSON.stringify(sqlConfig));
    await mssql.connect(sqlConfig);
    logInfo("SQL connection successful.");
    const request = new mssql.Request();
    request.input('clientID', mssql.NVarChar, client_id);
    const query = `
      SELECT STRING_AGG(CAST(e.id AS NVARCHAR(50)), ',') AS eventIDs
      FROM dbo.event_ids e
      INNER JOIN dbo.event_ids_client_relationship r ON e.id = r.event_id
      WHERE r.client_id = @clientID
    `;
    logInfo("Executing SQL query: " + query);
    const result = await request.query(query);
    logInfo("SQL query executed successfully.");
    mssql.close();
    if (result.recordset.length && result.recordset[0].eventIDs) {
      return result.recordset[0].eventIDs;
    }
    return "";
  } catch (err) {
    mssql.close();
    logError("Detailed SQL query error: " + JSON.stringify(err, null, 2));
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

// Updated scrapeEventLogs to query the SECURITY event logs using wevtutil instead of returning dummy data.
async function scrapeEventLogs(eventIDs, lastScrapedTime) {
  logInfo(`Scraping logs for Event IDs: ${eventIDs} since ${lastScrapedTime}`);
  
  const { exec } = require('child_process');
  const eventIDsArray = eventIDs.split(',').map(id => id.trim()).filter(Boolean);
  const logNames = ["Security", "Application", "System", "Setup"];
  let events = [];
  
  for (const logName of logNames) {
    for (const id of eventIDsArray) {
      const queryCmd = `wevtutil qe ${logName} /q:"*[System[EventID=${id} and TimeCreated[@SystemTime>='${lastScrapedTime}']]]" /f:xml /c:50`;
      logInfo(`Running query on ${logName} log: ${queryCmd}`);
      
      try {
        const stdout = await new Promise((resolve) => {
          exec(queryCmd, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) {
              logError(`Error executing command for EventID ${id} in ${logName}: ${err.message}`);
              return resolve('');
            }
            resolve(stdout);
          });
        });
        
        logInfo(`Raw output for EventID ${id} in ${logName}: ${stdout.substring(0,200)}...`);
        
        const eventBlocks = stdout.match(/<Event[\s\S]*?<\/Event>/gi);
        if (eventBlocks) {
          for (const block of eventBlocks) {
            // Updated regex to capture the TimeCreated SystemTime attribute
            const eventTimeRegex = /<TimeCreated[^>]*\sSystemTime=(?:"|')([^"']+)(?:"|')/i;
            const eventTime = (block.match(eventTimeRegex) || [])[1] || '';
            const eventID = (block.match(/<EventID>(\d+)<\/EventID>/i) || [])[1] || id;
            const provider = (block.match(/<Provider\s+Name=["'][^"']+["']?/i) || [])[1] || logName;
            // Updated regex to match both single and double quotes for TargetUserName
            let username = (block.match(/<Data\s+Name=["']TargetUserName["']>([^<]+)<\/Data>/i) || [])[1] || '';
            // Fallback to SubjectUserName if TargetUserName is empty
            if (!username) {
              username = (block.match(/<Data\s+Name=["']SubjectUserName["']>([^<]+)<\/Data>/i) || [])[1] || '';
            }
            // For event 4648, check for alternate account info
            if (eventID === "4648") {
              const alt = block.match(/Account\s+Name:\s*([\w@.\-]+)/i);
              if (alt && alt[1]) {
                username = alt[1];
              }
            }
            // Filter out events with username SYSTEM (case-insensitive)
            if (username && username.toLowerCase() === "system") {
              logInfo(`Ignoring event with username SYSTEM. EventID: ${eventID} in ${logName}`);
              continue;
            }

            events.push({
              client_id: null, // will be set later
              hostname: require('os').hostname(),
              event_id: eventID,
              event_name: provider,
              event_username: username,
              event_ip: "192.168.1.100",   // placeholder for local IP
              event_ext_ip: "8.8.8.8",      // placeholder for public IP
              event_type: "Information",   // placeholder
              event_description: block,    // use full XML as description
              event_timestamp: eventTime,
              uploaded_timestamp: null
            });
          }
        } else {
          logInfo(`No events found for EventID ${id} in ${logName}`);
        }
      } catch (e) {
        logError(`Exception while processing EventID ${id} in ${logName}: ${e.message}`);
      }
    }
  }
  return events;
}

// Uploads events to the SQL table local_audit_logs.
async function uploadEventsToSQL(client_id, sqlConfig, events) {
  if (!events.length) return true;
  try {
    await mssql.connect(sqlConfig);
    const transaction = new mssql.Transaction();
    await transaction.begin();
    for (const ev of events) {
      ev.client_id = client_id;
      ev.uploaded_timestamp = new Date();
      const request = new mssql.Request(transaction);
      // Use parameterized query to prevent issues with special characters.
      request.input('client_id', mssql.NVarChar, ev.client_id);
      request.input('hostname', mssql.NVarChar, ev.hostname);
      request.input('event_id', mssql.NVarChar, ev.event_id);
      request.input('event_name', mssql.NVarChar, ev.event_name);
      request.input('event_username', mssql.NVarChar, ev.event_username);
      // Updated parameter: send local IP as event_internal_ip
      request.input('event_internal_ip', mssql.NVarChar, ev.event_ip);
      request.input('event_ext_ip', mssql.NVarChar, ev.event_ext_ip);
      request.input('event_type', mssql.NVarChar, ev.event_type);
      request.input('event_description', mssql.NVarChar, ev.event_description);
      request.input('event_timestamp', mssql.DateTime, new Date(ev.event_timestamp));
      request.input('uploaded_timestamp', mssql.DateTime, ev.uploaded_timestamp);
      await request.query(`
        INSERT INTO local_audit_logs 
        (client_id, hostname, event_id, event_name, event_username, event_internal_ip, event_ext_ip, event_type, event_description, event_timestamp, uploaded_timestamp)
        VALUES 
        (@client_id, @hostname, @event_id, @event_name, @event_username, @event_internal_ip, @event_ext_ip, @event_type, @event_description, @event_timestamp, @uploaded_timestamp)
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

// Add a simple function to test SQL connectivity.
async function testSqlConnection(sqlConfig) {
  try {
    logInfo("Testing SQL connection...");
    await mssql.connect(sqlConfig);
    const result = await new mssql.Request().query("SELECT 1 AS connected");
    if (result.recordset && result.recordset[0] && result.recordset[0].connected === 1) {
      logInfo("SQL connection test succeeded.");
      mssql.close();
      return true;
    }
    mssql.close();
    logError("SQL connection test did not return expected result.");
    return false;
  } catch (err) {
    mssql.close();
    logError("SQL connection test error: " + err.message);
    return false;
  }
}

// Add a function to retrieve client info from the clients table.
async function getClientInfo(id, sqlConfig) {
  try {
    await mssql.connect(sqlConfig);
    const request = new mssql.Request();
    request.input('clientID', mssql.NVarChar, id);
    const query = `SELECT * FROM dbo.clients WHERE id = @clientID`;
    logInfo("Executing client info query: " + query);
    const result = await request.query(query);
    mssql.close();
    return result.recordset;
  } catch (err) {
    mssql.close();
    logError("Error retrieving client info: " + err.message);
    return null;
  }
}

// Add helper function to get the internal IP address.
function getInternalIP() {
  const interfaces = require('os').networkInterfaces();
  for (const iface of Object.values(interfaces)) {
    for (const details of iface) {
      if (details.family === 'IPv4' && !details.internal) {
        return details.address;
      }
    }
  }
  return '127.0.0.1';
}

// Add helper function to get the public IP address.
function getPublicIP() {
  return new Promise((resolve, reject) => {
    nodeHttps.get('https://api.ipify.org?format=json', res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.ip || '0.0.0.0');
        } catch (e) {
          resolve('0.0.0.0');
        }
      });
    }).on('error', err => {
      resolve('0.0.0.0');
    });
  });
}

// NEW: Load event descriptions from the event_ids table, with fallback to local cache.
async function loadEventDescriptions(sqlConfig) {
  const cacheFile = path.join(baseDir, "event_descriptions_cache.json");
  try {
    await mssql.connect(sqlConfig);
    const result = await new mssql.Request().query("SELECT id, event_id_description FROM dbo.event_ids");
    mssql.close();
    const mapping = {};
    if (result.recordset && result.recordset.length) {
      result.recordset.forEach(row => {
        mapping[row.id.toString()] = row.event_id_description;
      });
      // Update local cache file with the latest mapping.
      fs.writeFileSync(cacheFile, JSON.stringify(mapping, null, 2), 'utf8');
    }
    return mapping;
  } catch (err) {
    mssql.close();
    logError("Error loading event descriptions from SQL: " + err.message);
    // Attempt to load from local cache file if SQL retrieval fails.
    try {
      if (fs.existsSync(cacheFile)) {
        const data = fs.readFileSync(cacheFile, 'utf8');
        return JSON.parse(data);
      }
    } catch (cacheErr) {
      logError("Error loading event descriptions from local cache: " + cacheErr.message);
    }
    return {};
  }
}

// ------------------------
// Main Functionality
// ------------------------
(async () => {
  await checkForUpdate();

  let sqlConfig, client_id, allowedEventIDs;
  try {
    // Load SQL settings (including install path) from registry.
    const sqlSettings = await loadSqlConfig();
    client_id = sqlSettings.client_id;
    sqlConfig = createSqlConfig(sqlSettings);

    // Update baseDir and derived paths from registry value.
    baseDir = sqlSettings.installPath || baseDir;
    logsDir = path.join(baseDir, "logs");
    lastScrapeFile = path.join(baseDir, "last_scrape_timestamp.txt");
    cacheFile = path.join(baseDir, "cached_events.json");

    // Ensure base and logs directories exist.
    if (!fs.existsSync(baseDir)) {
      fs.mkdirSync(baseDir, { recursive: true });
      logInfo(`Created base directory: ${baseDir}`);
    }
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
      logInfo(`Created logs directory: ${logsDir}`);
    }

    // Test connection before proceeding.
    const isConnected = await testSqlConnection(sqlConfig);
    if (!isConnected) {
      logError("SQL connectivity test failed. Aborting further SQL operations.");
      // Optionally exit or continue with cached data.
    }

    // Retrieve client info and write to log file in the logs folder.
    const clientInfo = await getClientInfo(client_id, sqlConfig);
    if (clientInfo) {
      const logFile = path.join(logsDir, "client_info.log");
      fs.writeFileSync(logFile, JSON.stringify(clientInfo, null, 2));
      logInfo(`Client info logged to ${logFile}`);
    } else {
      logError("No client info found or error occurred.");
    }

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
      logError("No cached event IDs available. Defaulting to empty eventIDs.");
      allowedEventIDs = ""; 
    }
  }

  // Log startup to the event log.
  logInfo("Service started. Beginning event log scraping...");

  let lastScrapedTime = new Date().toISOString();
  let cachedEvents = loadCachedEvents();

  // Function to process event scraping and SQL upload.
  async function processEvents() {
    try {
      const scrapeStartTime = getLastScrapeTime();
      logInfo(`Performing scrape for client_id ${client_id} for Event IDs ${allowedEventIDs} from ${scrapeStartTime}`);
      
      // Update allowed event IDs on each scrape
      try {
        allowedEventIDs = await fetchEventIDsFromSQL(client_id, sqlConfig);
        await updateRegistryEventIDs(allowedEventIDs);
        logInfo(`Allowed Event IDs updated to: ${allowedEventIDs}`);
      } catch (err) {
        logError("Failed updating allowed Event IDs: " + err.message);
      }
      
      let events = await scrapeEventLogs(allowedEventIDs, scrapeStartTime);
      
      // Set client_id for each event.
      events.forEach(ev => { ev.client_id = client_id; });
      
      // Obtain current IP addresses.
      const internalIP = getInternalIP();
      const publicIP = await getPublicIP();
      events.forEach(ev => {
        ev.event_ip = internalIP;
        ev.event_ext_ip = publicIP;
      });
      
      // Update local scrape timestamp.
      updateLastScrapeTime();
      
      // Merge with any previously cached events and de-duplicate events.
      let cached = loadCachedEvents();
      events = cached.concat(events);
      const uniqueEvents = Array.from(new Map(
        events.map(ev => {
          const ts = ev.event_timestamp;
          const truncatedTime = ts.includes('.') ? ts.split('.')[0] : ts;
          return [truncatedTime + ev.event_id, ev];
        })
      ).values());
      
      // Replace long description with event_id_description from SQL mapping.
      const eventDescMapping = await loadEventDescriptions(sqlConfig);
      uniqueEvents.forEach(ev => {
        if (eventDescMapping[ev.event_id]) {
          ev.event_description = eventDescMapping[ev.event_id];
        }
      });
      
      // Log each event for diagnostics.
      uniqueEvents.forEach(ev => {
        logInfo(`Prepared event: ${JSON.stringify(ev)}`);
      });
      
      // New: Check SQL connectivity before attempting upload.
      const canConnect = await testSqlConnection(sqlConfig);
      if (!canConnect) {
        logError("SQL connection test failed during event processing. Caching events for next attempt.");
        saveCachedEvents(uniqueEvents);
        return;
      }
      
      // Immediately attempt to upload events to SQL.
      const uploadSuccess = await uploadEventsToSQL(client_id, sqlConfig, uniqueEvents);
      if (uploadSuccess) {
        // Clear local cache if data is successfully written.
        saveCachedEvents([]);
        logInfo("SQL upload successful. Cleared local cache.");
      } else {
        // Cache the events if upload failed.
        saveCachedEvents(uniqueEvents);
        logError("SQL upload failed. Cached events retained for next attempt.");
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

  // Call processEvents once immediately to verify that events are written.
  processEvents();

  // Handle termination signals gracefully.
  process.on('SIGTERM', () => {
    logInfo('Received SIGTERM, shutting down gracefully...');
    process.exit(0);
  });

  // Add global error handlers for better diagnostics
  process.on('uncaughtException', (err) => {
    logError("Uncaught Exception: " + err.stack);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason, promise) => {
    logError("Unhandled Rejection at: " + promise + ", reason: " + reason);
    process.exit(1);
  });

})();
