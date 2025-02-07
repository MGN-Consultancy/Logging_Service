# Setup Script for Logging Service

This script is used to set up the Logging Service. Below is an example of how to use the script, followed by a detailed description of each parameter.

Prior to installing this service you should create a unique account for a client using the following commands in your SQL instance which will create an account with query access to the event_ID table and write only access to the logging table. no other permissions will be assigned to this account. 

As additional security the SQL server only accepts connections from authorised IP addresses which will be client offices, for logging when a user is not in an approved location or from an approved IP address the logs will be cached locally and will upload when at an approved location. 

## Steps to auto update the application. 



## User setup script

-- Step 1: Create the user inside the database
CREATE USER [automation_user] WITH PASSWORD = 'YourSecurePassword123';

-- Step 2: Grant READ-ONLY access to specific tables
GRANT SELECT ON dbo.event_ids TO [automation_user];
GRANT SELECT ON dbo.event_ids_client_relationship TO [automation_user];

-- Step 3: Grant WRITE-ONLY access to dbo.local_audit_logs
GRANT INSERT ON dbo.local_audit_logs TO [automation_user];

-- Step 4: Deny additional permissions for safety
DENY DELETE, UPDATE ON dbo.local_audit_logs TO [automation_user];

-- Step 5: Deny access to all other tables in the database
-- (This ensures the user cannot query anything else)
DENY VIEW ANY TABLE TO [automation_user];


## Example Script Usage

```powershell
.\setup.ps1 -SQLServer "localhost" -SQLUser "admin" -SQLPass "password" -ClientID "12345" -DBName "LoggingDB" -Path "C:\InstallPath" -SilentInstall "yes" -SilentUninstall "no"

For an interactive installation simply run .\setup.ps1 as administrator and it will prompt you for entries.

the script will download a service wrapper and also download the latest application from github and when running as a service will periodically check for a newer version of the application for which is auto updates itself. 

Parameters
SQLServer
Type: String
Mandatory: No
Description: Specifies the SQL Server instance to connect to.

SQLUser
Type: String
Mandatory: No
Description: Specifies the username for SQL Server authentication.


SQLPass
Type: String
Mandatory: No
Description: Specifies the password for SQL Server authentication.

ClientID
Type: String
Mandatory: No
Description: Specifies the client identifier which is found within the automation database and is used to identify client records for filtering.

DBName
Type: String
Mandatory: No
Description: Specifies the name of the database to be used.

Path
Type: String
Mandatory: Yes
Description: Specifies the path where the service will be installed.

SilentInstall
Type: String
Mandatory: No
Default Value: "no"
Description: Specifies whether the installation should be silent when used for remote deployment. Accepts "yes" or "no".

SilentUninstall
Type: String
Mandatory: No
Default Value: "no"
Description: Specifies whether the uninstallation should be silent when used for remote uninstall. Accepts "yes" or "no".

Notes
Ensure that the path specified in the Path parameter exists and is writable.
If SilentInstall or SilentUninstall is set to "yes", the script will run without prompting for user input.