const { S3 } = require('@aws-sdk/client-s3');
const axios = require('axios');
const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');

const s3 = new S3({ region: 'us-east-1' });

const OUTPUT_BUCKET = 'ffmpeg-processed-videos-lance';
const BROLL_BUCKET = 'ffmpeg-broll-library'; // NEW: B-roll library bucket

exports.handler = async (event) => {
  console.log('Event received:', JSON.stringify(event));

  const { videoUrl, includeZoom = true, brollCount = 0 } = event; // NEW: brollCount parameter

  if (!videoUrl) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'videoUrl is required' }),
    };
  }

  const tmpDir = '/tmp';
  const inputVideo = path.join(tmpDir, 'input.mp4');
  const outputVideo = path.join(tmpDir, 'output.mp4');
  const audioFile = path.join(tmpDir, 'audio.mp3');
  const srtFile = path.join(tmpDir, 'subtitles.srt');

  try {
    // Step 1: Download input video
    console.log('Downloading input video from:', videoUrl);
    const response = await axios({
      method: 'get',
      url: videoUrl,
      responseType: 'stream',
    });

    const writer = fs.createWriteStream(inputVideo);
    response.data.pipe(writer);

    await new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    console.log('Video downloaded successfully');

    // Step 2: Extract audio for transcription
    console.log('Extracting audio...');
    execSync(`ffmpeg -i ${inputVideo} -q:a 0 -map a ${audioFile} -y`, { stdio: 'inherit' });

    // Step 3: Transcribe with OpenAI Whisper
    console.log('Transcribing audio with Whisper...');
    const transcription = await transcribeWithWhisper(audioFile);
    console.log('Transcription completed');

    // Step 4: Create SRT file from transcription
    console.log('Creating SRT file...');
    createSRTFile(transcription, srtFile);

    // NEW: Step 5: Handle B-roll if requested
    let finalInputVideo = inputVideo;
    
    if (brollCount > 0) {
      console.log(`Processing with ${brollCount} B-roll clips...`);
      const videoDuration = getVideoDuration(inputVideo);
      console.log(`Avatar video duration: ${videoDuration}s`);
      
      // Get random B-roll clips
      const brollClips = await getRandomBrollClips(brollCount, tmpDir);
      console.log(`Downloaded ${brollClips.length} B-roll clips`);
      
      // Calculate insertion points (evenly distributed)
      const insertionPoints = calculateInsertionPoints(videoDuration, brollCount);
      console.log('B-roll insertion points:', insertionPoints);
      
      // Build segments (avatar + broll alternating)
      const segments = buildSegments(inputVideo, brollClips, insertionPoints, videoDuration);
      console.log(`Created ${segments.length} segments`);
      
      // Stitch segments together
      const stitchedVideo = path.join(tmpDir, 'stitched.mp4');
      await stitchSegments(segments, stitchedVideo, tmpDir);
      console.log('Segments stitched successfully');
      
      finalInputVideo = stitchedVideo;
    }

    // Step 6: Add captions and zoom to final video
    console.log('Adding captions and zoom effects...');
    let filterComplex;

    if (includeZoom) {
      // Dynamic zoom with variety: 0.5s in → 4.5s hold → 0.5s out → 4.5s normal (10s cycle)
      // 30s pattern: 0-10s center, 10-20s right, 20-30s left, then repeats
      // Horizontal positioning targets eyes (60%/40%) instead of ears (65%/35%)
      filterComplex = `[0:v]zoompan=z='if(lt(mod(time,10),0.5), 1+(mod(time,10)/0.5)*0.15, if(lt(mod(time,10),5), 1.15, if(lt(mod(time,10),5.5), 1.15-((mod(time,10)-5)/0.5)*0.15, 1)))':x='if(lt(mod(time,30),10), iw/2-(iw/zoom/2), if(lt(mod(time,30),20), iw*0.60-(iw/zoom/2), iw*0.40-(iw/zoom/2)))':y='ih/3-(ih/zoom/2)':d=1:s=720x1280,subtitles=${srtFile}:force_style='FontName=Arial Bold,FontSize=18,PrimaryColour=&H00FFFF,OutlineColour=&H000000,Outline=3,Bold=1,Alignment=2,MarginV=55,MarginL=40,MarginR=40'[v]`;
    } else {
      filterComplex = `[0:v]subtitles=${srtFile}:force_style='FontName=Arial Bold,FontSize=18,PrimaryColour=&H00FFFF,OutlineColour=&H000000,Outline=3,Bold=1,Alignment=2,MarginV=55,MarginL=40,MarginR=40'[v]`;
    }

    const ffmpegCommand = `ffmpeg -i ${finalInputVideo} -filter_complex "${filterComplex}" -map "[v]" -map 0:a -c:v libx264 -preset fast -crf 23 -c:a copy ${outputVideo}`;
    
    console.log('Running FFmpeg command...');
    execSync(ffmpegCommand, { stdio: 'inherit' });
    console.log('FFmpeg processing completed');

    // Step 7: Upload to S3
    console.log('Uploading processed video to S3...');
    const outputKey = `processed-${Date.now()}.mp4`;
    const fileContent = fs.readFileSync(outputVideo);

    await s3.putObject({
      Bucket: OUTPUT_BUCKET,
      Key: outputKey,
      Body: fileContent,
      ContentType: 'video/mp4',
    });

    const s3Url = `https://${OUTPUT_BUCKET}.s3.amazonaws.com/${outputKey}`;
    console.log('Upload successful:', s3Url);

    // Cleanup
    console.log('Cleaning up temporary files...');
    [inputVideo, outputVideo, audioFile, srtFile].forEach((file) => {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    });

    // NEW: Cleanup B-roll clips and segments
    if (brollCount > 0) {
      const tmpFiles = fs.readdirSync(tmpDir);
      tmpFiles.forEach(file => {
        if (file.startsWith('broll_') || file.startsWith('segment_') || file === 'stitched.mp4' || file === 'concat.txt') {
          const filePath = path.join(tmpDir, file);
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        }
      });
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ videoUrl: s3Url }),
    };
  } catch (error) {
    console.error('Error processing video:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message }),
    };
  }
};

// NEW: Get random B-roll clips from S3
async function getRandomBrollClips(count, tmpDir) {
  console.log(`Fetching random ${count} clips from ${BROLL_BUCKET}...`);
  
  // List all objects in B-roll bucket
  const listResponse = await s3.listObjectsV2({
    Bucket: BROLL_BUCKET,
  });

  if (!listResponse.Contents || listResponse.Contents.length === 0) {
    throw new Error('No B-roll clips found in S3 bucket');
  }

  // Filter for video files only
  const videoFiles = listResponse.Contents.filter(obj => 
    obj.Key.endsWith('.mp4') || obj.Key.endsWith('.mov')
  );

  console.log(`Found ${videoFiles.length} video files in B-roll library`);

  // Shuffle and select random clips
  const shuffled = videoFiles.sort(() => 0.5 - Math.random());
  const selected = shuffled.slice(0, Math.min(count, videoFiles.length));

  // Download selected clips
  const clips = [];
  for (let i = 0; i < selected.length; i++) {
    const s3Object = selected[i];
    const localPath = path.join(tmpDir, `broll_${i}.mp4`);

    console.log(`Downloading B-roll clip: ${s3Object.Key}`);
    
    const getResponse = await s3.getObject({
      Bucket: BROLL_BUCKET,
      Key: s3Object.Key,
    });

    // Convert stream to buffer and write to file
    const chunks = [];
    for await (const chunk of getResponse.Body) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);
    fs.writeFileSync(localPath, buffer);

    const duration = getVideoDuration(localPath);
    
    clips.push({
      localPath,
      duration,
      key: s3Object.Key,
    });
  }

  return clips;
}

// NEW: Calculate where to insert B-roll clips
function calculateInsertionPoints(totalDuration, count) {
  const points = [];
  
  // Distribute evenly: at 25%, 50%, 75% for count=3
  // Avoid first 3 seconds (intro) and last 3 seconds (CTA)
  const startBuffer = 3;
  const endBuffer = 3;
  const usableDuration = totalDuration - startBuffer - endBuffer;
  
  const interval = usableDuration / (count + 1);
  
  for (let i = 1; i <= count; i++) {
    const point = startBuffer + (interval * i);
    points.push(point);
  }
  
  return points;
}

// NEW: Build video segments (avatar chunks + broll chunks)
function buildSegments(avatarVideo, brollClips, insertionPoints, totalDuration) {
  const segments = [];
  let currentTime = 0;
  const maxBrollDuration = 4; // Cap B-roll at 4 seconds each

  for (let i = 0; i < insertionPoints.length; i++) {
    const insertAt = insertionPoints[i];
    const broll = brollClips[i];

    // Avatar segment before B-roll
    if (insertAt > currentTime) {
      segments.push({
        type: 'avatar',
        input: avatarVideo,
        start: currentTime,
        duration: insertAt - currentTime,
      });
    }

    // B-roll segment (capped at 4 seconds)
    const brollDuration = Math.min(broll.duration, maxBrollDuration);
    segments.push({
      type: 'broll',
      input: broll.localPath,
      start: 0,
      duration: brollDuration,
    });

    currentTime = insertAt + brollDuration;
  }

  // Final avatar segment after last B-roll
  if (currentTime < totalDuration) {
    segments.push({
      type: 'avatar',
      input: avatarVideo,
      start: currentTime,
      duration: totalDuration - currentTime,
    });
  }

  return segments;
}

// NEW: Stitch all segments together
async function stitchSegments(segments, outputPath, tmpDir) {
  console.log('Extracting and preparing segments...');
  
  // Extract each segment as a separate file
  const segmentFiles = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const segmentPath = path.join(tmpDir, `segment_${i}.mp4`);

    if (seg.type === 'avatar') {
      // Extract avatar segment with timestamp
      console.log(`Extracting avatar segment ${i}: ${seg.start}s for ${seg.duration}s`);
      execSync(
        `ffmpeg -i ${seg.input} -ss ${seg.start} -t ${seg.duration} -c:v libx264 -preset ultrafast -crf 23 -c:a aac ${segmentPath} -y`,
        { stdio: 'inherit' }
      );
    } else {
      // Use B-roll clip (trim if needed)
      console.log(`Preparing B-roll segment ${i}: ${seg.duration}s`);
      execSync(
        `ffmpeg -i ${seg.input} -t ${seg.duration} -c:v libx264 -preset ultrafast -crf 23 -c:a aac ${segmentPath} -y`,
        { stdio: 'inherit' }
      );
    }

    segmentFiles.push(segmentPath);
  }

  // Create concat file
  const concatFile = path.join(tmpDir, 'concat.txt');
  const concatContent = segmentFiles.map(file => `file '${file}'`).join('\n');
  fs.writeFileSync(concatFile, concatContent);

  console.log('Concatenating segments...');
  // Use concat demuxer for fast concatenation
  execSync(
    `ffmpeg -f concat -safe 0 -i ${concatFile} -c copy ${outputPath} -y`,
    { stdio: 'inherit' }
  );

  console.log('Stitching complete');
}

// Get video duration in seconds
function getVideoDuration(videoPath) {
  const output = execSync(
    `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 ${videoPath}`
  ).toString();
  return parseFloat(output.trim());
}

// Transcribe audio using OpenAI Whisper API
async function transcribeWithWhisper(audioFile) {
  const formData = new FormData();
  formData.append('file', fs.createReadStream(audioFile));
  formData.append('model', 'whisper-1');
  formData.append('response_format', 'verbose_json');
  formData.append('timestamp_granularities[]', 'word');

  const response = await axios.post('https://api.openai.com/v1/audio/transcriptions', formData, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      ...formData.getHeaders(),
    },
  });

  return response.data;
}

// Create SRT file with 3-word chunks
function createSRTFile(transcription, outputFile) {
  const words = transcription.words;
  const srtEntries = [];
  let index = 1;

  for (let i = 0; i < words.length; i += 3) {
    const chunk = words.slice(i, i + 3);
    const text = chunk.map((w) => w.word).join(' ');
    const start = formatTimestamp(chunk[0].start);
    const end = formatTimestamp(chunk[chunk.length - 1].end);

    srtEntries.push(`${index}\n${start} --> ${end}\n${text}\n`);
    index++;
  }

  fs.writeFileSync(outputFile, srtEntries.join('\n'));
}

// Format timestamp for SRT (HH:MM:SS,mmm)
function formatTimestamp(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const millis = Math.floor((seconds % 1) * 1000);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
}
