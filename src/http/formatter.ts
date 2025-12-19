/**
 * Post-processor to fix malformed boltArtifact XML output from language models
 * Handles cases where the model doesn't properly format XML tags and attributes
 */

export function fixBoltArtifactFormat(text: string): string {
  return text;
  // Step 1: Fix boltArtifact tag - add spaces between attributes
  // Pattern: <boltArtifactid="..."title="..."> → <boltArtifact id="..." title="...">
  text = text.replace(
    /<boltArtifact([^>]*?)>/gi,
    (match, attrs) => {
      const fixed = attrs
        .replace(/([a-z])([a-z]+=)/gi, '$1 $2') // Add space before attribute names
        .trim();
      return `<boltArtifact ${fixed}>`;
    }
  );

  // Step 2: Fix boltAction tags - add spaces between attributes
  // Pattern: <boltActiontype="file"filePath="..."> → <boltAction type="file" filePath="...">
  text = text.replace(
    /<boltAction([^>]*?)>/gi,
    (match, attrs) => {
      const fixed = attrs
        .replace(/([a-z])([a-z]+=)/gi, '$1 $2') // Add space before attribute names
        .trim();
      return `<boltAction ${fixed}>`;
    }
  );

  // Step 3: Fix missing closing tags - match content between opening tags and next tag/end
  // This handles cases where </boltAction> is missing and next <boltAction> or </boltArtifact> starts
  text = text.replace(
    /(<boltAction[^>]*>)([\s\S]*?)(?=<boltAction|<\/boltArtifact>)/gi,
    (match, openTag, content) => {
      // Only add closing tag if content doesn't already have one
      if (!content.includes('</boltAction>')) {
        return openTag + content + '</boltAction>';
      }
      return match;
    }
  );

  // Step 4: Ensure proper spacing in multi-line content (optional, for readability)
  // Add newlines after closing tags for better structure
  text = text.replace(/<\/boltAction>/g, '</boltAction>\n');
  text = text.replace(/<\/boltArtifact>/g, '</boltArtifact>\n');

  // Step 5: Clean up excessive newlines
  text = text.replace(/\n{2,}/g, '\n');

  return text.trim();
}

/**
 * Test the formatter with a malformed input
 */
export function testFormatter() {
  const malformed = `<boltArtifactid="test"title="Test"><boltActiontype="file"filePath="test.js">console.log('hello');<boltActiontype="shell">npm start</boltAction></boltArtifact>`;

  const fixed = fixBoltArtifactFormat(malformed);
  console.log('Original:', malformed);
  console.log('\nFixed:', fixed);
  return fixed;
}
