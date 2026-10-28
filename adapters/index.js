import mock from "./mock.js";
import passthrough from "./passthrough.js";
import chatgpt from "./chatgpt.js";
import workbuddy from "./workbuddy.js";
import qoder from "./qoder.js";
import chatgptWeb from "./chatgpt-web.js";

const adapters = { mock, passthrough, chatgpt, workbuddy, qoder, "chatgpt-web": chatgptWeb };

export function getAdapter(name) {
  const adapter = adapters[name];
  if (!adapter) throw new Error(`unknown adapter: ${name}`);
  return adapter;
}
