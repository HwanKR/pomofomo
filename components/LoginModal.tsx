'use client';

import { useState } from 'react';
import toast from 'react-hot-toast';

interface LoginModalProps {
  isOpen: boolean;
  onClose: () => void;
  onGoogleLogin: () => void;
}

export default function LoginModal({
  isOpen,
  onClose,
  onGoogleLogin,
}: LoginModalProps) {
  const [email, setEmail] = useState('');

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in">
      {/* 모달 박스 */}
      <div className="bg-white text-gray-800 rounded-lg shadow-2xl w-full max-w-sm p-8 relative mx-4">
        {/* 닫기 버튼 (X) */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 text-gray-400 hover:text-gray-600"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={2}
            stroke="currentColor"
            className="w-6 h-6"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>

        {/* 헤더 */}
        <div className="text-center mb-6">
          <h2 className="text-gray-500 font-bold text-sm uppercase tracking-wider mb-1">
            Sign In
          </h2>
          <h1 className="text-2xl font-extrabold text-gray-700">
            Pomofomo 로그인
          </h1>
        </div>

        {/* 구글 로그인 버튼 */}
        <button
          onClick={onGoogleLogin}
          className="w-full flex items-center justify-center gap-3 bg-white border-2 border-gray-100 py-3 rounded-lg text-gray-600 font-bold shadow-sm hover:bg-gray-50 hover:border-gray-200 transition-all mb-6 group"
        >
          <img
            src="https://www.svgrepo.com/show/475656/google-color.svg"
            alt="Google"
            className="w-5 h-5 group-hover:scale-110 transition-transform"
          />
          Sign up with Google
        </button>

        {/* 구분선 (OR) */}
        <div className="flex items-center gap-4 mb-6">
          <div className="h-px bg-gray-200 flex-1"></div>
          <span className="text-gray-400 text-sm font-medium">or</span>
          <div className="h-px bg-gray-200 flex-1"></div>
        </div>

        {/* 이메일 로그인 (디자인만 구현, 기능은 준비중 처리) */}
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-bold text-gray-400 mb-1 uppercase">
              Email
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="example@mail.com"
              className="w-full bg-gray-100 border-none rounded text-gray-700 py-3 px-4 focus:ring-2 focus:ring-gray-300 outline-none transition-all"
            />
          </div>

          <button
            onClick={() =>
              toast(
                '이메일 로그인은 준비 중입니다.\n구글 로그인을 이용해주세요!',
                { icon: '🚧' }
              )
            }
            className="w-full bg-gray-800 text-white font-bold py-3 rounded hover:bg-gray-700 transition-colors shadow-lg"
          >
            Sign up with Email
          </button>
        </div>

        {/* 하단 링크 */}
        <div className="mt-6 text-center text-sm">
          <span className="text-gray-400">Already have an account? </span>
          <button
            onClick={onGoogleLogin}
            className="text-gray-800 font-bold hover:underline"
          >
            Log in
          </button>
        </div>
      </div>
    </div>
  );
}
