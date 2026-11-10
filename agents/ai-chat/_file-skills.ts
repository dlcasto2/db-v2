/**
 * File-processing skill prompts, shared by both Devon AI backends
 * (agents/ai-chat/index.ts on EdgeOne, app/ai-chat/route.ts everywhere else).
 *
 * Adapted from TencentEdgeOne/multimodal-file-assistant-agent (MIT): its
 * per-file-type skill text (_skills.ts) and PDF/chart generation templates
 * (_templates.ts), rewritten for Devon's own sandbox tool names (commands,
 * files, code_interpreter — same names on both backends) and its
 * suggest_actions / deliver_file tools, and trimmed to one language.
 *
 * Unlike the upstream template (one request per file, skills rebuilt fresh
 * each time), Devon AI is a standing conversation: someone uploads an image,
 * then a later turn with no new files clicks a suggested action like
 * "Compress image". So the short FILE_SKILLS_OVERVIEW is appended to the
 * system prompt on every turn once the sandbox is on — it's cheap and keeps
 * that follow-up working — while the fuller per-type blocks below (code
 * patterns, library calls) are only added on a turn that actually has files
 * of that type attached, when the detail is most useful and freshest.
 */

export const FILE_SKILLS_OVERVIEW =
  "File-processing capabilities (sandbox): pre-installed Python packages — Pillow (images), pandas/openpyxl (CSV/Excel), " +
  "pdfplumber/PyPDF2 (PDF text and tables), python-docx (Word), matplotlib (charts and generated PDFs), numpy. Don't pip install " +
  "any of these; only pip install for an ImportError on something NOT in that list.\n" +
  "- A user-uploaded image, PDF, Word or Excel file is already written into the sandbox (the system note tells you the path) — never ask the person to re-send it, and never fetch it with the files tool's read/write ops (those are text-only and will corrupt binary data); open it directly in Python with code_interpreter instead.\n" +
  "- After code_interpreter or commands produces an output file in the sandbox, call deliver_file(path, filename, description?) as your very next action to hand it to the person for download. Don't just mention the path, and don't re-verify with ls/stat/exists first — trust that the save you just made succeeded.\n" +
  "- When you've finished a file task (or want to offer the person a next step) call suggest_actions with 2-5 short options instead of writing a numbered list in your reply — plain-text suggestions aren't clickable. Skip it once you've just called deliver_file for a fully-finished task, once the person says they're done, or when what they asked for isn't something you can do (say so plainly instead — don't suggest a workaround that also won't work).\n"

export const SKILL_IMAGE =
  "## Image processing\n" +
  "Always the same pattern: open with Pillow from its sandbox path, process, save to a new path, then deliver_file the new path immediately — never use the files tool's read/write ops on images, they're text-only and corrupt binary data.\n" +
  "```python\nfrom PIL import Image\nimg = Image.open('<sandbox path>')\n# ... process ...\nimg.save('/tmp/output.jpg', quality=85, optimize=True)\n```\n" +
  "- Format conversion: PNG, JPEG, WebP, GIF, BMP, TIFF\n" +
  "- Compression: img.save(path, quality=N, optimize=True)\n" +
  "- Resize/crop: img.resize((w, h), Image.LANCZOS) / img.crop((left, top, right, bottom))\n" +
  "- Watermark: Pillow's ImageDraw, text or a semi-transparent overlay\n" +
  "- EXIF: img._getexif() / img.info.get('dpi')\n" +
  "- OCR is NOT available in this sandbox — don't suggest text extraction from images, or offer it if asked; say plainly it isn't supported here.\n"

export const SKILL_CSV =
  "## CSV & spreadsheet data\n" +
  "- Read: pd.read_csv(path) or pd.read_excel(path, sheet_name=None) for every sheet as a dict of DataFrames\n" +
  "- Profile: df.describe(), df.info(), df.value_counts(), null counts, correlations\n" +
  "- Transform: df.query(), boolean indexing, groupby/aggregate\n" +
  "- Chart: matplotlib (bar, line, pie, scatter, heatmap) from the DataFrame\n" +
  "- Export: df.to_excel(path) / df.to_csv(path, index=False) / df.to_markdown(tablefmt='pipe') for a quick table in your reply\n"

export const SKILL_PDF =
  "## PDF processing\n" +
  "- Extract text: pdfplumber.open(path).pages[i].extract_text()\n" +
  "- Extract tables: page.extract_tables() → list of lists\n" +
  "- Merge: PyPDF2.PdfMerger().append(path) per file, then .write(out_path)\n" +
  "- Metadata/page count: PyPDF2.PdfReader(path).metadata / len(reader.pages)\n"

export const SKILL_WORD =
  "## Word document processing\n" +
  "- Read: from docx import Document; doc = Document(path)\n" +
  "- Text: [p.text for p in doc.paragraphs]; tables: doc.tables → table.rows, row.cells\n" +
  "- To PDF: read the content with python-docx, then render it with the PDF-generation pattern below\n"

export const SKILL_MIXED =
  "## Working across several files at once\n" +
  "Read each file with the matching approach above, then either synthesize one combined summary, diff/contrast them, or merge their content into one report. Process sequentially and say what you found in each before combining.\n"

export const SKILL_PDF_GENERATION =
  "## Generating a PDF or chart\n" +
  "Use matplotlib (+ PdfPages for a multi-page PDF) for anything you generate — not fpdf2, which can't render non-Latin scripts. Probe for a font that covers whatever script the content uses (CJK, Cyrillic, etc.) instead of assuming Latin-only, " +
  "since Devon AI is used worldwide:\n" +
  "```python\nimport os, matplotlib\nmatplotlib.use('Agg')\nimport matplotlib.pyplot as plt\nfrom matplotlib.font_manager import FontProperties\n\n" +
  "_FONT_CANDIDATES = [\n" +
  "    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',\n" +
  "    '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',\n" +
  "    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',\n" +
  "]\n" +
  "_font_path = next((p for p in _FONT_CANDIDATES if os.path.exists(p)), None)\n" +
  "font = FontProperties(fname=_font_path) if _font_path else FontProperties()\n" +
  "```\n" +
  "Save the result to /tmp/, print one confirmation line, then call deliver_file immediately — don't verify the save with another tool call first, and don't run a second code_interpreter pass just to double-check.\n"

interface UploadedFileLike {
  name: string
  binary?: boolean
}

function extensionOf(name: string): string {
  return name.split(".").pop()?.toLowerCase() || ""
}

/** Per-type skill detail for the file types present in THIS turn's uploads (empty when there are none). */
export function buildFileSkillsPrompt(files: UploadedFileLike[]): string {
  if (!files.length) return ""
  const kinds = new Set<string>()
  for (const file of files) {
    const ext = extensionOf(file.name)
    if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "tiff", "svg"].includes(ext)) kinds.add("image")
    else if (ext === "csv" || ["xls", "xlsx"].includes(ext)) kinds.add("csv")
    else if (ext === "pdf") kinds.add("pdf")
    else if (["doc", "docx"].includes(ext)) kinds.add("word")
  }
  if (kinds.size > 1) kinds.add("mixed")
  if (!kinds.size) return ""

  const blocks: string[] = []
  if (kinds.has("image")) blocks.push(SKILL_IMAGE)
  if (kinds.has("csv")) blocks.push(SKILL_CSV)
  if (kinds.has("pdf")) blocks.push(SKILL_PDF)
  if (kinds.has("word")) blocks.push(SKILL_WORD)
  if (kinds.has("mixed")) blocks.push(SKILL_MIXED)
  blocks.push(SKILL_PDF_GENERATION)
  return blocks.join("\n")
}
