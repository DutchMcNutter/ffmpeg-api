# Use AWS Lambda Node.js base image
FROM public.ecr.aws/lambda/nodejs:18

# Install FFmpeg and dependencies
RUN yum install -y \
    wget \
    tar \
    xz \
    && wget https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz \
    && tar xvf ffmpeg-release-amd64-static.tar.xz \
    && mv ffmpeg-*-amd64-static/ffmpeg /usr/local/bin/ \
    && mv ffmpeg-*-amd64-static/ffprobe /usr/local/bin/ \
    && rm -rf ffmpeg-* \
    && yum clean all

# Copy package files
COPY package*.json ./

# Install Node.js dependencies
RUN npm install --production

# Copy application code
COPY index.js ./

# Set the Lambda handler
CMD [ "index.handler" ]
