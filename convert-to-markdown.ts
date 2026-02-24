import * as fs from "fs";
import * as path from "path";

interface Reply {
  author: string;
  time: string;
  content: string;
  likes: number;
}

interface DiscussionDetail {
  title: string;
  url: string;
  author: string;
  authorRole?: string;
  time: string;
  content: string;
  views: number;
  likes: number;
  comments: number;
  replies: Reply[];
}

function forumTitleFromFilename(filename: string): string {
  return path
    .basename(filename, ".json")
    .replace(/_full$/, "")
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function convertToMarkdown(discussions: DiscussionDetail[], title: string): string {
  let markdown = `# Jobber Community Forum - ${title}\n\n`;
  markdown += `Total Discussions: ${discussions.length}\n\n`;
  markdown += "---\n\n";

  discussions.forEach((discussion, index) => {
    // Main discussion title
    markdown += `## ${index + 1}. ${discussion.title}\n\n`;

    // Metadata section
    markdown += `**Author:** ${discussion.author}`;
    if (discussion.authorRole) {
      markdown += ` (${discussion.authorRole})`;
    }
    markdown += "\n";
    markdown += `**Posted:** ${discussion.time}\n`;
    markdown += `**Views:** ${discussion.views} | **Likes:** ${discussion.likes} | **Comments:** ${discussion.comments}\n`;
    markdown += `**URL:** ${discussion.url}\n\n`;

    // Main content
    if (discussion.content) {
      markdown += `### Content\n\n`;
      markdown += `${discussion.content}\n\n`;
    }

    // Replies section
    if (discussion.replies && discussion.replies.length > 0) {
      markdown += `### Replies (${discussion.replies.length})\n\n`;

      discussion.replies.forEach((reply, replyIndex) => {
        markdown += `#### Reply ${replyIndex + 1}\n\n`;
        markdown += `**Author:** ${reply.author}\n`;
        markdown += `**Posted:** ${reply.time}\n`;
        if (reply.likes > 0) {
          markdown += `**Likes:** ${reply.likes}\n`;
        }
        markdown += `\n${reply.content}\n\n`;
      });
    }

    markdown += "---\n\n";
  });

  return markdown;
}

const SKIP_FILES = new Set(["scrape_metadata.json", "package.json", "package-lock.json", "tsconfig.json"]);

function main() {
  const dir = process.argv[2] || ".";

  const jsonFiles = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !SKIP_FILES.has(f));

  if (jsonFiles.length === 0) {
    console.log("No JSON files found.");
    return;
  }

  console.log(`Found ${jsonFiles.length} JSON file(s) to convert.\n`);

  for (const filename of jsonFiles) {
    const inputFile = path.join(dir, filename);
    const outputFile = path.join(dir, filename.replace(".json", ".md"));

    try {
      const jsonContent = fs.readFileSync(inputFile, "utf-8");
      const discussions: DiscussionDetail[] = JSON.parse(jsonContent);

      if (!Array.isArray(discussions)) {
        console.warn(`Skipping ${filename}: not an array of discussions.`);
        continue;
      }

      const title = forumTitleFromFilename(filename);
      const markdown = convertToMarkdown(discussions, title);
      fs.writeFileSync(outputFile, markdown, "utf-8");

      console.log(
        `[OK] ${filename} → ${path.basename(outputFile)}  (${discussions.length} discussions, ${(markdown.length / 1024).toFixed(2)} KB)`
      );
    } catch (err) {
      console.error(`[ERROR] ${filename}: ${(err as Error).message}`);
    }
  }
}

main();
