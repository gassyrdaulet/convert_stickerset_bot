import TelegramBot from "node-telegram-bot-api";
import fs from "fs";
import axios from "axios";
import archiver from "archiver";
import sharp from "sharp";
import ffmpeg from "fluent-ffmpeg";

process.env.NTBA_FIX_350 = true; //get rid of a deprecation warning

const { BOT_TOKEN, AUTHOR_NAME } = JSON.parse(
  fs.readFileSync("./token.json").toString()
);

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
console.log("Bot successfully started.");

const processing = [];

function spliceProcessing(from) {
  const indexToRemove = processing.indexOf(from);
  if (indexToRemove !== -1) {
    processing.splice(indexToRemove, 1);
  }
}

function zipDirectory(sourceDir, outPath) {
  const archive = archiver("zip", { zlib: { level: 9 } });
  const stream = fs.createWriteStream(outPath);
  return new Promise((resolve, reject) => {
    archive
      .directory(sourceDir, false)
      .on("error", (err) => reject(err))
      .pipe(stream);
    stream.on("close", () => resolve());
    archive.finalize();
  });
}

async function getStickerPack(stickerPackId) {
  try {
    const pack = await bot.getStickerSet(stickerPackId);
    return pack;
  } catch (error) {
    console.log("Failed to receive stickerpack.:", error);
  }
}

const downloadSticker = async (fileId, filePath) => {
  const file = await bot.getFile(fileId);
  const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
  const response = await axios.get(fileUrl, { responseType: "arraybuffer" });
  await sharp(response.data)
    .resize(512, 512, {
      fit: "contain",
      background: { r: 255, g: 255, b: 255, alpha: 0 },
    })
    .toFile(filePath + ".webp");
};

const downloadVideoSticker = async (fileId, filePath, from) => {
  const file = await bot.getFile(fileId);
  const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
  const response = await axios.get(fileUrl, { responseType: "arraybuffer" });
  const tempFilePath = `./${from}/temp_file`;
  fs.writeFileSync(tempFilePath, response.data);
  await new Promise((resolve, reject) => {
    ffmpeg(tempFilePath)
      .outputOptions([
        "-vf",
        "fps=10,scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2",
        "-loop",
        "0",
      ])
      .toFormat("webp")
      .on("end", () => {
        resolve();
      })
      .on("error", (err) => {
        reject(err);
      })
      .save(filePath + ".webp");
  });
};

const downloadThumb = async (fileId, filePath) => {
  try {
    const file = await bot.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
    const response = await axios.get(fileUrl, { responseType: "arraybuffer" });
    await sharp(response.data)
      .resize(96, 96, {
        fit: "contain",
        background: { r: 255, g: 255, b: 255, alpha: 0 },
      })
      .toFormat("png")
      .toFile(filePath);
  } catch {
    fs.copyFileSync("./star.png", filePath);
  }
};

bot.on("message", async (msg) => {
  if (processing.includes(msg.from.id)) {
    await bot.deleteMessage(msg.chat.id, msg.message_id);
  }
});

bot.on("sticker", async (msg) => {
  if (processing.includes(msg.from.id)) return;
  if (processing.length > 10) {
    bot.sendMessage(msg.chat.id, "Bot is busy. Please try again later");
    return;
  }
  const loadingMessage = await bot.sendMessage(msg.chat.id, "Loading...");
  processing.push(msg.from.id);
  try {
    const dir = `./${msg.from.id}/temp/`;
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const { sticker } = msg;
    const stickerPackId = sticker?.set_name;
    if (!stickerPackId) {
      bot.sendMessage(msg.chat.id, "Failed to receive stickerpack..", {
        reply_to_message_id: msg.message_id,
      });
      spliceProcessing(msg.from.id);
      return;
    }

    const { thumbnail, stickers, title } = await getStickerPack(stickerPackId);
    if (stickers && Array.isArray(stickers)) {
      let steady = 0;
      let failed = 0;
      let video = 0;
      let success = 0;
      for (let i = 0; i < stickers.length; i += 30) {
        const packNumber = Math.ceil((i + 1) / 30);
        const batchStickers = stickers.slice(i, i + 30);
        const batchDir = `${dir}pack_${packNumber}/`;
        fs.mkdirSync(batchDir, { recursive: true });
        await downloadThumb(thumbnail?.file_id, batchDir + "icon.png");
        for (let sticker of batchStickers) {
          try {
            await bot.editMessageText(
              `Converting: ${success}/${stickers.length}`,
              {
                chat_id: msg.chat.id,
                message_id: loadingMessage.message_id,
              }
            );
          } catch {}
          const fileId = sticker.file_id;
          try {
            if (sticker.is_animated) continue;
            if (sticker.is_video) {
              await downloadVideoSticker(
                fileId,
                batchDir + fileId,
                msg.from.id
              );
              video++;
            } else {
              await downloadSticker(fileId, batchDir + fileId);
              steady++;
            }
            success++;
          } catch {
            failed++;
          }
        }
        if (packNumber === 1 && success < 3) {
          await bot.deleteMessage(msg.chat.id, loadingMessage.message_id);
          bot.sendMessage(
            msg.chat.id,
            "Less than 3 stickers uploaded. The stickerpack is not valid.",
            {
              reply_to_message_id: msg.message_id,
            }
          );
          spliceProcessing(msg.from.id);
          return;
        }
        fs.writeFileSync(batchDir + "author.txt", AUTHOR_NAME);
        fs.writeFileSync(batchDir + "title.txt", title);
        const zipArchivePath =
          `./${msg.from.id}/` + stickerPackId + `_pack${packNumber}.wastickers`;
        await zipDirectory(batchDir, zipArchivePath);
        await bot.sendDocument(
          msg.chat.id,
          fs.createReadStream(zipArchivePath),
          {
            reply_to_message_id: msg.message_id,
            caption: `${packNumber} часть.`,
          }
        );
      }
      if (success === 0) {
        await bot.deleteMessage(msg.chat.id, loadingMessage.message_id);
        bot.sendMessage(
          msg.chat.id,
          "No stickers have been uploaded. Make sure that the sticker you sent is from a regular or video sticker pack (not animated).",
          {
            reply_to_message_id: msg.message_id,
          }
        );
        spliceProcessing(msg.from.id);
        return;
      }
      await bot.deleteMessage(msg.chat.id, loadingMessage.message_id);
      await bot.sendMessage(
        msg.chat.id,
        `Conversion of the “${title}” sticker pack is complete.\nStickers loaded: ${success} pcs.\nRegular stickers: ${steady} pcs.\nVideo stickers: ${video} pcs.\nFailed to convert: ${failed} pcs.`,
        {
          reply_to_message_id: msg.message_id,
        }
      );
      fs.rmSync(`./${msg.from.id}/`, { recursive: true, force: true });
      spliceProcessing(msg.from.id);
    } else {
      await bot.deleteMessage(msg.chat.id, loadingMessage.message_id);
      await bot.sendMessage(msg.chat.id, "Failed to receive stickerpack.", {
        reply_to_message_id: msg.message_id,
      });
      spliceProcessing(msg.from.id);
    }
  } catch (e) {
    await bot.deleteMessage(msg.chat.id, loadingMessage.message_id);
    await bot.sendMessage(msg.chat.id, "Failed to convert stickerpack.", {
      reply_to_message_id: msg.message_id,
    });
    spliceProcessing(msg.from.id);
    console.log(
      `Failed to convert stickerpack. (CHAT ID: ${msg.chat.id}):\n`,
      e
    );
  }
});
