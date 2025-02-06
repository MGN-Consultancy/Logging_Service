param(
    [Parameter(Mandatory=$false)]
    [string]$SQLServer,
    [Parameter(Mandatory=$false)]
    [string]$SQLUser,
    [Parameter(Mandatory=$false)]
    [string]$SQLPass,
    [Parameter(Mandatory=$false)]
    [string]$ClientID,
    [Parameter(Mandatory=$false)]
    [string]$DBName,
    [string]$Path
)

# Define registry key, service name, and default installation directory
$regKey = "HKLM:\SOFTWARE\auditservice"
$serviceName = "AuditLoggingService"
$defaultInstallDir = "C:\program files\logging_service"

# Define NSSM installation folder and path to NSSM executable
$NssmInstallFolder = "C:\program files\nssm"
$nssmPath = Join-Path $NssmInstallFolder "win64\nssm.exe"

# Function: Install-NSSM if not already present
function Install-NSSM {
    param (
        [string]$InstallFolder = "C:\nssm"
    )
    $nssmZipUrl = "https://nssm.cc/release/nssm-2.24.zip"
    $zipFile = Join-Path $env:TEMP "nssm.zip"
    $tempExtract = Join-Path $env:TEMP "nssm_extract"

    Write-Host "NSSM not found. Downloading NSSM from $nssmZipUrl..."
    try {
        Invoke-WebRequest -Uri $nssmZipUrl -OutFile $zipFile -UseBasicParsing
    } catch {
        Write-Host "Error downloading NSSM: $_"
        exit 1
    }

    Write-Host "Extracting NSSM..."
    try {
        if (Test-Path $tempExtract) { Remove-Item $tempExtract -Recurse -Force }
        Expand-Archive -Path $zipFile -DestinationPath $tempExtract -Force
    } catch {
        Write-Host "Error extracting NSSM: $_"
        exit 1
    }
    
    # Locate the extracted NSSM folder (e.g. "nssm-2.24")
    $extractedFolder = Get-ChildItem -Path $tempExtract | Where-Object { $_.PSIsContainer } | Select-Object -First 1
    if (-not $extractedFolder) {
        Write-Host "Failed to locate extracted NSSM folder."
        exit 1
    }
    $sourceWin64 = Join-Path $extractedFolder.FullName "win64"
    $destWin64 = Join-Path $InstallFolder "win64"
    if (-not (Test-Path $destWin64)) {
        New-Item -ItemType Directory -Path $destWin64 -Force | Out-Null
    }
    Copy-Item -Path (Join-Path $sourceWin64 "*") -Destination $destWin64 -Recurse -Force

    Remove-Item $zipFile -Force
    Remove-Item $tempExtract -Recurse -Force
    Write-Host "NSSM installed successfully to $InstallFolder."
}

# Check if NSSM is installed, if not then install it
if (-not (Test-Path $nssmPath)) {
    Install-NSSM -InstallFolder $NssmInstallFolder
}

# Function: Download a file from a URL
function Download-File {
    param(
        [string]$Url,
        [string]$Destination
    )
    try {
        Write-Host "Downloading file from $Url to $Destination..."
        $client = New-Object System.Net.WebClient
        $client.DownloadFile($Url, $Destination)
        Write-Host "Download completed."
    }
    catch {
        Write-Host "Error downloading file: $_"
        exit 1
    }
}

# Prompt for installation directory if -Path not provided
if (-not $Path) {
    $installDir = Read-Host "Enter installation directory for audit_service.exe (Default: $defaultInstallDir)"
    if ([string]::IsNullOrWhiteSpace($installDir)) {
        $installDir = $defaultInstallDir
    }
} else {
    $installDir = $Path
}

if (-not (Test-Path $installDir)) {
    Write-Host "Creating installation directory: $installDir"
    New-Item -ItemType Directory -Path $installDir -Force | Out-Null
}

# Define the GitHub URL for audit_service.exe (your provided URL)
$listenerUrl = "https://github.com/MGN-Consultancy/Logging_Service/blob/e64aace714c64e22d66692b89d30104b0bbe784c/audit_service_1.0.0.exe"
$listenerExePath = Join-Path $installDir "audit_service_1.0.0.exe"

# Download listener.exe to the chosen installation directory
Download-File -Url $listenerUrl -Destination $listenerExePath

# Function: Manage registry values
function Manage-RegistryValues {
    $values = @(
        @{ Name = "client_id"; Prompt = "Enter value for client_id (should match IAM_portal):" },
        @{ Name = "path"; Prompt = "Enter installation path:" },
        @{ Name = "SQLServer"; Prompt = "Enter value for your SQL Server (from Azure SQL):" },
        @{ Name = "DB_NAME"; Prompt = "Enter value for your Database Name (from Azure SQL):" },
        @{ Name = "SQLUser"; Prompt = "Enter value for Database Username:" },
        @{ Name = "SQLPass"; Prompt = "Enter value for Database Passphrase:" }
    )
    $config = @{}
    if (Test-Path $regKey) {
        Write-Host "Registry key '$regKey' exists."
        $update = Read-Host "Do you want to update the registry values? (y/n)"
        if ($update -notlike "y") {
            Write-Host "Skipping registry updates."
            return $null
        }
    } else {
        Write-Host "Registry key '$regKey' does not exist. Creating it..."
        New-Item -Path $regKey -Force | Out-Null
    }
    foreach ($value in $values) {
        $userInput = Read-Host $value.Prompt
        Set-ItemProperty -Path $regKey -Name $value.Name -Value $userInput
        Write-Host "Key '$($value.Name)' set to '$userInput'."
        $config[$value.Name] = $userInput
    }
    Write-Host "Registry values have been updated successfully."
    return $config
}

# Function: Manage the service registration using NSSM
function Manage-Service {
    param(
         [string]$ListenerExePath
    )
    
    # Verify that the executable exists before proceeding
    if (-not (Test-Path $ListenerExePath)) {
        Write-Host "Error: The file '$ListenerExePath' does not exist."
        exit 1
    }
    
    # Check if the service already exists
    if (Get-Service -Name $serviceName -ErrorAction SilentlyContinue) {
        Write-Host "Service '$serviceName' already exists."
        $uninstall = Read-Host "Do you want to uninstall the service? (y/n)"
        if ($uninstall -like "y") {
            Write-Host "Stopping and removing service '$serviceName'..."
            Stop-Service -Name $serviceName -Force -ErrorAction SilentlyContinue
            & $nssmPath remove $serviceName confirm
            Write-Host "Service '$serviceName' has been uninstalled."
            return $true
        } else {
            Write-Host "Service will remain installed. No changes made."
            return $false
        }
    } else {
        Write-Host "Service '$serviceName' does not exist."
        $install = Read-Host "Do you want to install the service? (y/n)"
        if ($install -like "y") {
            Write-Host "Registering '$ListenerExePath' as a service using NSSM..."
            # Wrap the executable path in quotes for safety
            & $nssmPath install $serviceName "`"$ListenerExePath`""
            # Set the working directory for the service
            & $nssmPath set $serviceName AppDirectory $installDir
            # Optionally redirect standard output and error to log files
            & $nssmPath set $serviceName AppStdout (Join-Path $installDir "audit_stdout.log")
            & $nssmPath set $serviceName AppStderr (Join-Path $installDir "audit_stderr.log")
            
            Write-Host "Starting service '$serviceName'..."
            Start-Service -Name $serviceName
            Write-Host "Service '$serviceName' has been registered and started successfully."
            return $true
        } else {
            $runListener = Read-Host "Do you want to run the audit_service directly as an application? (y/n)"
            if ($runListener -like "y") {
                Write-Host "Starting audit service directly..."
                Start-Process -FilePath $ListenerExePath -NoNewWindow
            } else {
                Write-Host "Exiting script without making changes."
                exit 0
            }
        }
    }
}

# Main logic
Write-Host "Checking registry values..."

# If all parameters are provided, ask whether to use them or update via prompts.
if ($SQLServer -and $SQLUser -and $SQLPass -and $ClientID -and $DBName -and $Path) {
    $useParams = Read-Host "Registry parameters were provided. Use these values? (y/n)"
    if ($useParams -notlike "y") {
        $userConfig = Manage-RegistryValues
        if ($userConfig) {
            $SQLServer = $userConfig["SQLServer"]
            $SQLUser   = $userConfig["SQLUser"]
            $SQLPass   = $userConfig["SQLPass"]
            $ClientID  = $userConfig["client_id"]
            $DBName    = $userConfig["DB_NAME"]
            $installDir= $userConfig["path"]
        }
    }
    else {
        $installDir = $Path
    }
}
else {
    $userConfig = Manage-RegistryValues
    if ($userConfig) {
        $SQLServer = $userConfig["SQLServer"]
        $SQLUser   = $userConfig["SQLUser"]
        $SQLPass   = $userConfig["SQLPass"]
        $ClientID  = $userConfig["client_id"]
        $DBName    = $userConfig["DB_NAME"]
        $installDir= $userConfig["path"]
    }
}

Write-Host "Managing service registration..."
$serviceUpdated = Manage-Service -ListenerExePath $listenerExePath

# Define the registry key path
$regPath = $regKey

# Create the registry key if it doesn't exist
if (-not (Test-Path $regPath)) {
    New-Item -Path $regPath -Force | Out-Null
}
# Set default event_ids if not already present.
if ((Get-ItemProperty -Path $regPath -Name "event_ids" -ErrorAction SilentlyContinue).event_ids -eq $null) {
    Set-ItemProperty -Path $regPath -Name "event_ids" -Value "0"
    Write-Host "Default event_ids set to '0'."
}

# Write the registry values using selected configuration.
Set-ItemProperty -Path $regPath -Name "SQLServer" -Value $SQLServer
Set-ItemProperty -Path $regPath -Name "SQLUser" -Value $SQLUser
Set-ItemProperty -Path $regPath -Name "SQLPass" -Value $SQLPass
Set-ItemProperty -Path $regPath -Name "client_id" -Value $ClientID
Set-ItemProperty -Path $regPath -Name "DB_NAME" -Value $DBName
Set-ItemProperty -Path $regPath -Name "path" -Value $installDir

Write-Output "Installation complete. Registry values are set."

if (-not $userConfig -and -not $serviceUpdated) {
    Write-Host "No changes were made to registry values or the service. Exiting script."
    exit 0
}

Write-Host "Script execution completed."
Read-Host "Press Enter to exit"
