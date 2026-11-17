// 圧縮データの展開ヘルパ。JPX の xlsx (zip) と PDF (FlateDecode ストリーム) を読むのに使う。
// 展開はランタイム組み込みの DecompressionStream に任せ、ここは zip の目次走査と PDF の
// ストリーム切り出しだけを持つ。

async function inflate(
	bytes: Uint8Array,
	format: "deflate" | "deflate-raw",
): Promise<Uint8Array> {
	const stream = new Blob([bytes])
		.stream()
		.pipeThrough(new DecompressionStream(format));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

// zip から名前が match に合う最初のエントリを取り出してバイト列で返す。無ければ null。
// 中央ディレクトリ (末尾の EOCD から辿る) を走査し、stored(0) / deflate(8) だけを扱う。
export async function unzipBytes(
	zip: Uint8Array,
	match: string | ((name: string) => boolean),
): Promise<Uint8Array | null> {
	const hit = typeof match === "string" ? (n: string) => n === match : match;
	const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
	let eocd = -1;
	for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i--) {
		if (view.getUint32(i, true) === 0x06054b50) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) return null;
	const entries = view.getUint16(eocd + 10, true);
	let p = view.getUint32(eocd + 16, true);
	const decoder = new TextDecoder("utf-8");
	for (let n = 0; n < entries; n++) {
		if (view.getUint32(p, true) !== 0x02014b50) return null;
		const method = view.getUint16(p + 10, true);
		const compSize = view.getUint32(p + 20, true);
		const nameLen = view.getUint16(p + 28, true);
		const extraLen = view.getUint16(p + 30, true);
		const commentLen = view.getUint16(p + 32, true);
		const localOffset = view.getUint32(p + 42, true);
		const entryName = decoder.decode(zip.subarray(p + 46, p + 46 + nameLen));
		p += 46 + nameLen + extraLen + commentLen;
		if (!hit(entryName)) continue;
		const localNameLen = view.getUint16(localOffset + 26, true);
		const localExtraLen = view.getUint16(localOffset + 28, true);
		const start = localOffset + 30 + localNameLen + localExtraLen;
		const data = zip.subarray(start, start + compSize);
		if (method === 0) return data;
		if (method === 8) return inflate(data, "deflate-raw");
		return null;
	}
	return null;
}

// zip から name のエントリを取り出して UTF-8 文字列で返す。無ければ null。
export async function unzipText(
	zip: Uint8Array,
	name: string,
): Promise<string | null> {
	const bytes = await unzipBytes(zip, name);
	return bytes ? new TextDecoder("utf-8").decode(bytes) : null;
}

// PDF の FlateDecode ストリームを展開し、latin1 文字列の配列で返す (展開できないものは飛ばす)。
// テキスト抽出は呼び出し側が演算子列 (TJ/Tj の括弧文字列) を読む。
export async function pdfStreams(pdf: Uint8Array): Promise<string[]> {
	const latin1 = new TextDecoder("latin1").decode(pdf);
	const out: string[] = [];
	let from = 0;
	for (;;) {
		const s = latin1.indexOf("stream", from);
		if (s < 0) break;
		if (latin1.startsWith("endstream", s - 3)) {
			from = s + 6;
			continue;
		}
		let start = s + "stream".length;
		if (latin1[start] === "\r") start++;
		if (latin1[start] === "\n") start++;
		const end = latin1.indexOf("endstream", start);
		if (end < 0) break;
		from = end + "endstream".length;
		const dict = latin1.slice(latin1.lastIndexOf("<<", s), s);
		if (!dict.includes("FlateDecode")) continue;
		// endstream 直前の改行はデータに含めない (後ろにゴミがあると展開が失敗する)。
		let stop = end;
		if (latin1[stop - 1] === "\n") stop--;
		if (latin1[stop - 1] === "\r") stop--;
		try {
			const raw = await inflate(pdf.subarray(start, stop), "deflate");
			out.push(new TextDecoder("latin1").decode(raw));
		} catch {
			// 末尾の改行ぶん長さがずれたストリームや画像は展開に失敗しうる。読めるものだけ使う。
		}
	}
	return out;
}

if (import.meta.vitest) {
	const { describe, it, expect } = import.meta.vitest;

	const compress = async (
		text: string,
		format: "deflate" | "deflate-raw",
	): Promise<Uint8Array> => {
		const stream = new Blob([new TextEncoder().encode(text)])
			.stream()
			.pipeThrough(new CompressionStream(format));
		return new Uint8Array(await new Response(stream).arrayBuffer());
	};

	// 1 エントリの zip を組み立てる (local header + data + central directory + EOCD)。
	const buildZip = (name: string, data: Uint8Array, method: number) => {
		const nameBytes = new TextEncoder().encode(name);
		const local = new Uint8Array(30 + nameBytes.length);
		const lv = new DataView(local.buffer);
		lv.setUint32(0, 0x04034b50, true);
		lv.setUint16(8, method, true);
		lv.setUint32(18, data.length, true);
		lv.setUint16(26, nameBytes.length, true);
		local.set(nameBytes, 30);
		const central = new Uint8Array(46 + nameBytes.length);
		const cv = new DataView(central.buffer);
		cv.setUint32(0, 0x02014b50, true);
		cv.setUint16(10, method, true);
		cv.setUint32(20, data.length, true);
		cv.setUint16(28, nameBytes.length, true);
		cv.setUint32(42, 0, true);
		central.set(nameBytes, 46);
		const eocd = new Uint8Array(22);
		const ev = new DataView(eocd.buffer);
		ev.setUint32(0, 0x06054b50, true);
		ev.setUint16(10, 1, true);
		ev.setUint32(16, local.length + data.length, true);
		const out = new Uint8Array(
			local.length + data.length + central.length + eocd.length,
		);
		out.set(local, 0);
		out.set(data, local.length);
		out.set(central, local.length + data.length);
		out.set(eocd, local.length + data.length + central.length);
		return out;
	};

	describe("unzipText", () => {
		it("deflate エントリを展開する", async () => {
			const data = await compress("<sst>日本語</sst>", "deflate-raw");
			const zip = buildZip("xl/sharedStrings.xml", data, 8);
			expect(await unzipText(zip, "xl/sharedStrings.xml")).toBe(
				"<sst>日本語</sst>",
			);
		});
		it("stored エントリはそのまま返す", async () => {
			const zip = buildZip("a.txt", new TextEncoder().encode("plain"), 0);
			expect(await unzipText(zip, "a.txt")).toBe("plain");
		});
		it("無いエントリ・zip でないデータは null", async () => {
			const zip = buildZip("a.txt", new TextEncoder().encode("plain"), 0);
			expect(await unzipText(zip, "b.txt")).toBeNull();
			expect(await unzipText(new Uint8Array(10), "a.txt")).toBeNull();
		});
	});

	describe("pdfStreams", () => {
		it("FlateDecode ストリームだけを展開する", async () => {
			const body = await compress("BT [(42.4%)] TJ ET", "deflate");
			const head = new TextEncoder().encode(
				`%PDF-1.7\n4 0 obj\n<</Filter/FlateDecode/Length ${body.length}>>\nstream\r\n`,
			);
			const tail = new TextEncoder().encode(
				"\r\nendstream\nendobj\n5 0 obj\n<</Length 3>>\nstream\nabc\nendstream\n",
			);
			const pdf = new Uint8Array(head.length + body.length + tail.length);
			pdf.set(head, 0);
			pdf.set(body, head.length);
			pdf.set(tail, head.length + body.length);
			expect(await pdfStreams(pdf)).toEqual(["BT [(42.4%)] TJ ET"]);
		});
	});
}
