import axios from 'axios';

const api = axios.create({
  baseURL: '',
  withCredentials: true,
  timeout: 60000,
});

// Guests have a valid session but get 401 from app APIs; redirecting to /login would loop.
export const authState = { isGuest: false };

api.interceptors.response.use(
  res => res,
  err => {
    if (err.response?.status === 401 && !authState.isGuest && window.location.pathname !== '/login') {
      window.location.href = '/login';
    }
    return Promise.reject(err);
  }
);

export default api;
