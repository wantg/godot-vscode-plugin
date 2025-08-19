import * as vscode from "vscode";
import type {
	CancellationToken,
	CustomDocument,
	CustomDocumentOpenContext,
	CustomReadonlyEditorProvider,
	ExtensionContext,
	Uri,
	WebviewPanel,
} from "vscode";
import type { NotificationMessage } from "vscode-jsonrpc";
import type {
	NativeSymbolInspectParams,
	GodotNativeSymbol,
	GodotNativeClassInfo,
	GodotCapabilities,
} from "./documentation_types";
import { make_html_content } from "./documentation_builder";
import { createLogger, get_configuration, get_extension_uri, make_docs_uri } from "../utils";
import { globals } from "../extension";

const log = createLogger("providers.docs");
const logOutput = createLogger("providers.docs", { output: "Godot Document" });

export class GDDocumentationProvider implements CustomReadonlyEditorProvider {
	public classInfo = new Map<string, GodotNativeClassInfo>();
	public symbolDb = new Map<string, GodotNativeSymbol>();
	public htmlDb = new Map<string, string>();

	private ready = false;

	constructor(private context: ExtensionContext) {
		const options = {
			webviewOptions: {
				enableScripts: true,
				retainContextWhenHidden: true,
				enableFindWidget: true,
			},
			supportsMultipleEditorsPerDocument: true,
		};
		context.subscriptions.push(vscode.window.registerCustomEditorProvider("gddoc", this, options));
	}

	public register_capabilities(message: NotificationMessage) {
		for (const gdclass of (message.params as GodotCapabilities).native_classes) {
			this.classInfo.set(gdclass.name, gdclass);
		}
		for (const gdclass of this.classInfo.values()) {
			if (gdclass.inherits) {
				if (!this.classInfo.has(gdclass.inherits)) {
					this.classInfo.set(gdclass.inherits, {
						name: gdclass.inherits,
						inherits: "",
					});
				}
				const extended_classes = this.classInfo.get(gdclass.inherits).extended_classes || [];
				extended_classes.push(gdclass.name);
				this.classInfo.get(gdclass.inherits).extended_classes = extended_classes;
			}
		}
		this.ready = true;
	}

	public async list_native_classes() {
		const classname = await vscode.window.showQuickPick([...this.classInfo.keys()].sort(), {
			placeHolder: "Type godot class name here",
			canPickMany: false,
		});
		if (classname) {
			vscode.commands.executeCommand("vscode.open", make_docs_uri(classname));
		}
	}

	public openCustomDocument(
		uri: Uri,
		openContext: CustomDocumentOpenContext,
		token: CancellationToken,
	): CustomDocument {
		return { uri: uri, dispose: () => {} };
	}

	public async resolveCustomEditor(
		document: CustomDocument,
		panel: WebviewPanel,
		token: CancellationToken,
	): Promise<void> {
		const className = document.uri.path.split(".")[0];
		const target = document.uri.fragment;

		let extendedDocURL = `https://docs.godotengine.org/zh-cn/latest/classes/class_${className.toLowerCase()}.html`;
		if (target.length > 0) {
			let clsName = className.startsWith("@") ? className.substring(1) : className
			let fragment = '';
			if (target.startsWith('_')) {
				fragment = `class-${clsName.toLowerCase()}-private-method-${target.substring(1).replaceAll('_', '-')}`
			} else {
				fragment = `class-${clsName.toLowerCase()}-method-${target.replaceAll('_', '-')}`
			}
			extendedDocURL += `#${fragment}`;
		}
		logOutput.info(`className is ${className}, target is "${target}", open ${extendedDocURL}`);
		vscode.commands.executeCommand("simpleBrowser.show", extendedDocURL);

		panel.dispose()
		return;

		let symbol: GodotNativeSymbol = null;

		panel.webview.options = {
			enableScripts: true,
		};

		while (!this.ready) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		symbol = this.symbolDb.get(className);

		if (!symbol && this.classInfo.has(className)) {
			const params: NativeSymbolInspectParams = {
				native_class: className,
				symbol_name: className,
			};

			const response = await globals.lsp.client.send_request("textDocument/nativeSymbol", params);

			symbol = response as GodotNativeSymbol;
			symbol.class_info = this.classInfo.get(symbol.name);
			this.symbolDb.set(symbol.name, symbol);
		}
		if (!this.htmlDb.has(className)) {
			this.htmlDb.set(className, make_html_content(panel.webview, symbol, target));
		}

		const scaleFactor = get_configuration("documentation.pageScale");
		panel.webview.html = this.htmlDb.get(className).replaceAll("scaleFactor", scaleFactor);

		const displayMinimap = get_configuration("documentation.displayMinimap");
		if (displayMinimap) {
			panel.webview.html = this.htmlDb.get(className).replace("displayMinimap", "initial;");
			panel.webview.html = this.htmlDb.get(className).replace("bodyMargin", "200px;");
		} else {
			panel.webview.html = this.htmlDb.get(className).replace("bodyMargin", "0px;");
			panel.webview.html = this.htmlDb.get(className).replace("displayMinimap", "none;");
		}

		panel.iconPath = get_extension_uri("resources/godot_icon.svg");
		panel.webview.onDidReceiveMessage((msg) => {
			if (msg.type === "INSPECT_NATIVE_SYMBOL") {
				const uri = make_docs_uri(msg.data.native_class, msg.data.symbol_name);
				vscode.commands.executeCommand("vscode.open", uri);
			}
		});

		if (target) {
			panel.webview.postMessage({
				command: "focus",
				target: target,
			});
		}
	}
}
