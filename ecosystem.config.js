module.exports = {
  apps: [
    {
      name: 'omnimail-web',
      script: 'src/server.js',
      node_args: '--no-warnings --experimental-sqlite',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        DATABASE_PATH: './omnimail.db',
        ADMIN_SECRET: 'change-this-to-a-secure-random-secret',
      },
      error_file: './logs/web-error.log',
      out_file: './logs/web-out.log',
      time: true,
    },
    {
      name: 'omnimail-worker',
      script: 'src/worker.js',
      node_args: '--no-warnings --experimental-sqlite',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
        DATABASE_PATH: './omnimail.db',
      },
      error_file: './logs/worker-error.log',
      out_file: './logs/worker-out.log',
      time: true,
    },
  ],
};
