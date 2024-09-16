import TelegramBot from "node-telegram-bot-api";
import fs from "fs";
import axios from "axios";
import archiver from "archiver";
import sharp from "sharp";
import ffmpeg from "fluent-ffmpeg";

const { BOT_TOKEN, AUTHOR_NAME } = JSON.parse(
  fs.readFileSync("./token.json").toString()
);

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
console.log("Бот успешно запущен.");

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
    console.log("Ошибка при получении стикерпака:", error);
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
    bot.sendMessage(
      msg.chat.id,
      "Бот перегружен. Пожалуйста, попробуйте еще раз позже."
    );
    return;
  }
  const loadingMessage = await bot.sendMessage(msg.chat.id, "Загрузка...");
  processing.push(msg.from.id);
  try {
    const dir = `./${msg.from.id}/temp/`;
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const { sticker } = msg;
    const stickerPackId = sticker?.set_name;
    if (!stickerPackId) {
      bot.sendMessage(msg.chat.id, "Не удалось определить стикерпак.", {
        reply_to_message_id: msg.message_id,
      });
      spliceProcessing(msg.from.id);
      return;
    }

    const { thumbnail, stickers, title } = await getStickerPack(stickerPackId);
    await downloadThumb(thumbnail?.file_id, dir + "icon.png");
    if (stickers && Array.isArray(stickers)) {
      let steady = 0;
      let failed = 0;
      let video = 0;
      let success = 0;
      for (let sticker of stickers) {
        if (success >= 30) break;
        try {
          await bot.editMessageText(
            `Конвертация стикеров: ${success}/${
              stickers.length > 30 ? 30 : stickers.length
            }`,
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
            await downloadVideoSticker(fileId, dir + fileId, msg.from.id);
            video++;
          } else {
            await downloadSticker(fileId, dir + fileId);
            steady++;
          }
          success++;
        } catch {
          failed++;
        }
      }
      if (success === 0) {
        await bot.deleteMessage(msg.chat.id, loadingMessage.message_id);
        bot.sendMessage(
          msg.chat.id,
          "Не загружено ни одного стикера. Убедитесь, что отправленный вами стикер из обычного или видео стикерпака (не анимированного).",
          {
            reply_to_message_id: msg.message_id,
          }
        );
        spliceProcessing(msg.from.id);
        return;
      }
      if (success < 3) {
        await bot.deleteMessage(msg.chat.id, loadingMessage.message_id);
        bot.sendMessage(
          msg.chat.id,
          "Выгрузилось меньше 3 стикеров. Стикерпак не действителен.",
          {
            reply_to_message_id: msg.message_id,
          }
        );
        spliceProcessing(msg.from.id);
        return;
      }
      fs.writeFileSync(dir + "author.txt", AUTHOR_NAME);
      fs.writeFileSync(dir + "title.txt", title);
      const zipArchivePath =
        `./${msg.from.id}/` + stickerPackId + ".wastickers";
      await zipDirectory(dir, zipArchivePath);

      await bot.deleteMessage(msg.chat.id, loadingMessage.message_id);
      await bot.sendDocument(msg.chat.id, fs.createReadStream(zipArchivePath), {
        reply_to_message_id: msg.message_id,
        caption: `Конвертация стикерпака «${title}» завершена.\nЗагружено стикеров: ${success} шт.\nОбычные стикеры: ${steady} шт.\nВидео-стикеры: ${video} шт.\nНе удалось сконвертировать: ${failed} шт.`,
      });
      fs.rmSync(`./${msg.from.id}/`, { recursive: true, force: true });
      spliceProcessing(msg.from.id);
    } else {
      await bot.deleteMessage(msg.chat.id, loadingMessage.message_id);
      await bot.sendMessage(msg.chat.id, "Не удалось получить стикерпак.", {
        reply_to_message_id: msg.message_id,
      });
      spliceProcessing(msg.from.id);
    }
  } catch (e) {
    await bot.deleteMessage(msg.chat.id, loadingMessage.message_id);
    await bot.sendMessage(
      msg.chat.id,
      "Не удалось сконвертировать стикерпак.",
      {
        reply_to_message_id: msg.message_id,
      }
    );
    spliceProcessing(msg.from.id);
    console.log(
      `Не удалось сконвертировать стикерпак (CHAT ID: ${msg.chat.id}):\n`,
      e
    );
  }
});
