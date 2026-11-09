// Server-Sent Events の解析（POST /chat のストリーム）。届いた順に少しずつ渡してよい。

export type SseMessage = { readonly event: string; readonly data: string };

/** テキストを順に feed すると、空行で区切られたイベントごとに onMessage を呼ぶ */
export function createSseParser(onMessage: (m: SseMessage) => void) {
  let buffer = "";
  let event = "message";
  let data: string[] = [];
  const dispatch = () => {
    if (data.length > 0) onMessage({ event, data: data.join("\n") });
    event = "message";
    data = [];
  };
  return {
    feed(chunk: string) {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.search(/\r\n|\r|\n/)) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + (buffer.startsWith("\r\n", nl) ? 2 : 1));
        if (line === "") dispatch();
        else if (line.startsWith(":")) continue;
        else {
          const i = line.indexOf(":");
          const field = i < 0 ? line : line.slice(0, i);
          const value = i < 0 ? "" : line.slice(i + 1).replace(/^ /, "");
          if (field === "event") event = value;
          else if (field === "data") data.push(value);
        }
      }
    },
    end() {
      dispatch();
    },
  };
}
