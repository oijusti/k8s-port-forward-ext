import * as vscode from "vscode";
import { exec } from "child_process";

function execPromise(cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        reject(error);
      } else if (stderr) {
        reject(new Error(stderr));
      } else {
        resolve(stdout);
      }
    });
  });
}

// Spinner implementation for output channel
class Spinner {
  // private spinnerChars = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  // private index = 0;
  private intervalId: NodeJS.Timeout | null = null;
  private message: string = "";
  private outputChannel: vscode.OutputChannel;

  constructor(outputChannel: vscode.OutputChannel) {
    this.outputChannel = outputChannel;
  }

  start(message: string): void {
    if (this.intervalId) return; // Spinner is already running

    this.message = message;
    this.outputChannel.append(`${this.message}...`);

    this.intervalId = setInterval(() => {
      // Simpler approach - just append the spinner character
      // this.outputChannel.append("\b" + this.spinnerChars[this.index]);
      this.outputChannel.append(".");
      // this.index = (this.index + 1) % this.spinnerChars.length;
    }, 100);
  }

  stop(success: boolean = true): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;

      // Simply append the completion text
      this.outputChannel.append(`${success ? "done" : "failed"}.`);
      // this.outputChannel.appendLine(""); // Add a new line
    }
  }
}

async function getNamespaces(
  outputChannel: vscode.OutputChannel,
  spinner: Spinner,
): Promise<string[]> {
  const getNamespacesCommand =
    "kubectl get namespaces -o jsonpath={.items[*].metadata.name}";

  outputChannel.appendLine(`Running: ${getNamespacesCommand}`);
  spinner.start("Loading namespaces");

  const nsOutput = await execPromise(getNamespacesCommand);
  const namespaces: string[] = nsOutput.trim().split(/\s+/);
  spinner.stop();

  return namespaces;
}

async function getPods(
  namespace: string | null,
  outputChannel: vscode.OutputChannel,
  spinner: Spinner,
): Promise<string> {
  const getPodsCommand = namespace
    ? `kubectl get pods --namespace ${namespace}`
    : "kubectl get pods --all-namespaces";

  outputChannel.appendLine(`Running: ${getPodsCommand}`);
  spinner.start("Loading services");

  const podsData = await execPromise(getPodsCommand);
  spinner.stop();

  return podsData;
}

async function getServicePort(
  serviceNamespace: string,
  serviceName: string,
  outputChannel: vscode.OutputChannel,
  spinner: Spinner,
): Promise<string> {
  const getServicePortCommand = `kubectl get service --namespace ${serviceNamespace} ${serviceName} -o jsonpath={.spec.ports[*].port}`;
  outputChannel.appendLine(`Running: ${getServicePortCommand}`);

  spinner.start("Detecting port on the Kubernetes service");

  try {
    const servicePort = await execPromise(getServicePortCommand);
    spinner.stop();
    outputChannel.appendLine(`\nPort detected: ${servicePort}`);
    return servicePort;
  } catch (error) {
    spinner.stop(false);
    outputChannel.appendLine(`Error detecting port: ${error}`);
    return "3000"; // Default value if detection fails
  }
}

function isValidPort(value: string): boolean {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= 65535;
}

function nextAvailablePort(
  startPort: number,
  reservedPorts: Set<string>,
): string {
  let p = startPort;
  while (reservedPorts.has(String(p))) p++;
  return String(p);
}

function parseServicesMap(podsData: string, namespace: string | null) {
  const servicesMap = new Map();
  const lines = podsData.trim().split("\n");

  // Get headers to find indices
  const headers = lines[0].split(/\s+/);
  const namespaceIndex = headers.indexOf("NAMESPACE");
  const nameIndex = headers.indexOf("NAME");
  const statusIndex = headers.indexOf("STATUS");

  for (let i = 1; i < lines.length; i++) {
    const columns = lines[i].split(/\s+/);

    // Read STATUS column (if present) and skip non-Running entries
    const statusColumn = statusIndex !== -1 ? columns[statusIndex] : undefined;
    if (statusColumn !== undefined && statusColumn !== "Running") {
      continue;
    }

    const namespaceColumn = namespace ?? columns[namespaceIndex];
    const nameColumn = columns[nameIndex];

    // Categorize services by environment based on prefix: "dev-", "qa-", "stg-", "prod-", or "default"
    const envPrefixes = ["dev", "qa", "stg", "prod"] as const;
    const envPrefix =
      envPrefixes.find((env) => nameColumn.startsWith(`${env}-`)) ?? "default";

    const parts = nameColumn.split("-");
    if (parts.length > 2) {
      const serviceName = parts.slice(0, -2).join("-");
      const serviceId = parts.slice(-2).join("-");

      const envPrefixStripRegex = new RegExp(`^(${envPrefixes.join("|")})-`);
      let shortServiceName = serviceName.replace(envPrefixStripRegex, "");
      if (namespaceColumn) {
        shortServiceName = shortServiceName.replace(
          new RegExp(`^${namespaceColumn}-`, "g"),
          "",
        );
      }

      if (!servicesMap.has(shortServiceName)) {
        servicesMap.set(shortServiceName, {});
      }
      servicesMap.get(shortServiceName)[envPrefix] = {
        id: serviceId,
        namespace: namespaceColumn,
        serviceName,
      };
    }
  }
  return servicesMap;
}

export function activate(context: vscode.ExtensionContext) {
  // Store multiple terminals in an array
  const terminals: vscode.Terminal[] = [];
  // Store output channels in an array
  const outputChannels: vscode.OutputChannel[] = [];

  const disposable = vscode.commands.registerCommand(
    "k8s-port-forward.start",
    async () => {
      // Create unique output channel for this service instance
      const outputChannel = vscode.window.createOutputChannel(
        `K8s Port Forward - ${new Date().toLocaleTimeString()}`,
      );
      outputChannels.push(outputChannel);
      outputChannel.show();

      // Create spinner instance
      const spinner = new Spinner(outputChannel);

      try {
        // Get namespaces
        const namespaces = await getNamespaces(outputChannel, spinner);

        const nsPick = await vscode.window.showQuickPick(
          ["--all-namespaces", ...namespaces],
          {
            placeHolder: "Select a namespace (or all)",
            ignoreFocusOut: true,
          },
        );
        if (!nsPick) return;
        outputChannel.appendLine(`\nYou selected namespace: ${nsPick}`);
        const namespace = nsPick === "--all-namespaces" ? null : nsPick;

        // Get pods
        const podsData = await getPods(namespace, outputChannel, spinner);

        // Process services
        const servicesMap = parseServicesMap(podsData, namespace || null);
        const servicesList = Array.from(servicesMap.keys()).sort();

        if (servicesList.length === 0) {
          vscode.window.showInformationMessage("No services found");
          return;
        }

        // Select service(s) - with multiselect support
        const selectedServices = await vscode.window.showQuickPick(
          servicesList,
          {
            placeHolder: "Select one or more services",
            ignoreFocusOut: true,
            canPickMany: true,
          },
        );

        if (!selectedServices || selectedServices.length === 0) return;

        // Output the selected services
        outputChannel.appendLine(
          `\nYou selected ${
            selectedServices.length
          } service(s): ${selectedServices.join(", ")}`,
        );

        const reservedLocalPorts = new Set<string>();

        interface ServiceConfig {
          selectedService: string;
          environment: string;
          serviceDetails: {
            id: string;
            namespace: string;
            serviceName: string;
          };
          localPort: string;
          servicePort: string;
          showLogs: boolean;
        }

        const selectedConfigs: ServiceConfig[] = [];

        // Phase 1: collect configuration for all selected services
        for (const selectedService of selectedServices) {
          outputChannel.appendLine(
            `\n--- Configuring service: ${selectedService} ---`,
          );

          const availableEnvs = Object.keys(
            servicesMap.get(selectedService) || {},
          );
          const environment = await vscode.window.showQuickPick(availableEnvs, {
            placeHolder: `Select environment for ${selectedService}`,
            ignoreFocusOut: true,
          });
          if (!environment) {
            outputChannel.appendLine(
              `Skipped ${selectedService} - no environment selected`,
            );
            continue;
          }

          outputChannel.appendLine(`Selected environment: ${environment}`);

          const serviceDetails =
            servicesMap.get(selectedService)?.[environment];
          outputChannel.appendLine(`Service ID: ${serviceDetails.id}`);
          outputChannel.appendLine(
            `Service namespace: ${serviceDetails.namespace}`,
          );
          outputChannel.appendLine(
            `Service name: ${serviceDetails.serviceName}`,
          );

          const suggestedLocalPort = nextAvailablePort(
            3000,
            reservedLocalPorts,
          );
          let localPort =
            (await vscode.window.showInputBox({
              prompt: `Enter local port for ${selectedService} (default: ${suggestedLocalPort})`,
              placeHolder: suggestedLocalPort,
              value: suggestedLocalPort,
              ignoreFocusOut: true,
            })) || suggestedLocalPort;
          if (!isValidPort(localPort) || reservedLocalPorts.has(localPort)) {
            outputChannel.appendLine(
              `Invalid or already used port "${localPort}", using ${suggestedLocalPort}`,
            );
            localPort = suggestedLocalPort;
          }
          reservedLocalPorts.add(localPort);
          outputChannel.appendLine(`Local port: ${localPort}`);

          const serviceNamespace = namespace || serviceDetails.namespace;

          let servicePort = await getServicePort(
            serviceNamespace,
            serviceDetails.serviceName,
            outputChannel,
            spinner,
          );
          servicePort =
            (await vscode.window.showInputBox({
              prompt: `Enter the destination port on the Kubernetes service for ${selectedService}. Try using port 3000 if the detected port fails`,
              placeHolder: "3000",
              value: servicePort || "3000",
              ignoreFocusOut: true,
            })) || "3000";
          outputChannel.appendLine(`Destination port: ${servicePort}`);

          const showLogsAnswer = await vscode.window.showQuickPick(
            ["Yes", "No"],
            {
              placeHolder: `Would you like to see the logs in real time for ${selectedService}?`,
              ignoreFocusOut: true,
            },
          );
          const showLogs = showLogsAnswer === "Yes";
          outputChannel.appendLine(`Show logs: ${showLogsAnswer ?? "No"}`);

          selectedConfigs.push({
            selectedService,
            environment,
            serviceDetails,
            localPort,
            servicePort,
            showLogs,
          });
        }

        if (selectedConfigs.length === 0) {
          vscode.window.showInformationMessage(
            "No services configured. Select at least one and choose an environment.",
          );
          return;
        }

        // Phase 2: run all port-forwards and logs terminals at once
        outputChannel.appendLine(
          `\n--- Starting port forwarding for ${selectedConfigs.length} service(s) ---`,
        );
        spinner.start("Initializing port forwarding");
        outputChannel.appendLine("");

        const urls: string[] = [];

        for (const cfg of selectedConfigs) {
          const envLabel =
            cfg.environment !== "default" ? `${cfg.environment}~` : "";

          const serviceNamespace = namespace || cfg.serviceDetails.namespace;
          const podName = `${cfg.serviceDetails.serviceName}-${cfg.serviceDetails.id}`;

          const portForwardCommand = `kubectl port-forward --namespace ${serviceNamespace} ${podName} ${cfg.localPort}:${cfg.servicePort}`;
          outputChannel.appendLine(`Running: ${portForwardCommand}`);

          const terminal = vscode.window.createTerminal({
            name: `k8s — ${envLabel}${cfg.selectedService}:${cfg.localPort}`,
            iconPath: new vscode.ThemeIcon("diff-renamed"),
            color: new vscode.ThemeColor("terminal.ansiGreen"),
          });
          terminals.push(terminal);
          terminal.show();
          terminal.sendText(portForwardCommand);

          urls.push(`http://localhost:${cfg.localPort}`);

          if (!cfg.showLogs) continue;
          const logsCommand = `kubectl logs --namespace ${serviceNamespace} ${podName} -f`;
          outputChannel.appendLine(`Running: ${logsCommand}`);

          const logsTerminal = vscode.window.createTerminal({
            name: `k8s — ${envLabel}${cfg.selectedService}:${cfg.localPort}`,
            iconPath: new vscode.ThemeIcon("note"),
            color: new vscode.ThemeColor("terminal.ansiYellow"),
          });
          terminals.push(logsTerminal);
          logsTerminal.show();
          logsTerminal.sendText(logsCommand);
        }

        spinner.stop();
        outputChannel.appendLine(
          `\n✓ Completed processing ${selectedConfigs.length} service(s)`,
        );
        vscode.window.showInformationMessage(
          `Port forwarding started: ${urls.join(", ")}`,
        );
      } catch (error) {
        // Make sure spinner is stopped if there's an error
        if (spinner) {
          spinner.stop(false); // Pass false to indicate failure
        }
        vscode.window.showErrorMessage(`Error: ${error}`);
      }
    },
  );

  context.subscriptions.push(disposable);
}

export function deactivate() {}
